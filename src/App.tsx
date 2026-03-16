import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { PitchDetector } from 'pitchy'

type Mode = 'free' | 'challenge'
type MicState = 'idle' | 'requesting' | 'listening' | 'error'
type ChallengePhase = 'idle' | 'listening' | 'result'

type NoteProfile = {
  id: string
  label: string
  instrumentName: string
  frequency: number
}

type DetectionSnapshot = {
  frequency: number
  clarity: number
  volume: number
  closestNote: NoteProfile | null
  centsOffset: number | null
}

type ChallengeState = {
  phase: ChallengePhase
  targetId: string | null
  score: number
  round: number
  secondsLeft: number
  lastResult: string
}

// Fingering: 6 holes top-to-bottom, true = covered
const FINGERINGS: Record<string, boolean[]> = {
  D5:   [true, true, true, true, true, true],
  E5:   [true, true, true, true, true, false],
  'F#5':[true, true, true, true, false, false],
  G5:   [true, true, true, false, false, false],
  A5:   [true, true, false, false, false, false],
  B5:   [true, false, false, false, false, false],
  'C#6':[false, true, false, false, false, false],
  D6:   [false, true, true, true, true, true],
}

const INPUT_LENGTH = 2048
const CLARITY_GATE = 0.9
const VOLUME_GATE = 0.015
const MIN_FREQUENCY = 500
const MAX_FREQUENCY = 2500
const HIT_TOLERANCE_CENTS = 25
const ROUND_DURATION_MS = 3000
const RESULT_PAUSE_MS = 1200
const WAVE_SAMPLES = 72
const NOTE_SETS: NoteProfile[] = [
  { id: 'D5', label: 'D5', instrumentName: 'Low D', frequency: 587.33 },
  { id: 'E5', label: 'E5', instrumentName: 'E', frequency: 659.25 },
  { id: 'F#5', label: 'F#5', instrumentName: 'F#', frequency: 739.99 },
  { id: 'G5', label: 'G5', instrumentName: 'G', frequency: 783.99 },
  { id: 'A5', label: 'A5', instrumentName: 'A', frequency: 880.0 },
  { id: 'B5', label: 'B5', instrumentName: 'B', frequency: 987.77 },
  { id: 'C#6', label: 'C#6', instrumentName: 'C#', frequency: 1108.73 },
  { id: 'D6', label: 'D6', instrumentName: 'High D', frequency: 1174.66 },
]

const EMPTY_DETECTION: DetectionSnapshot = {
  frequency: 0,
  clarity: 0,
  volume: 0,
  closestNote: null,
  centsOffset: null,
}

const EMPTY_CHALLENGE: ChallengeState = {
  phase: 'idle',
  targetId: null,
  score: 0,
  round: 0,
  secondsLeft: ROUND_DURATION_MS / 1000,
  lastResult: 'Start a 3-second round when you are ready.',
}

function formatSignedCents(value: number | null) {
  if (value === null) {
    return '--'
  }

  const rounded = Math.round(value)
  if (rounded === 0) {
    return '0'
  }

  return `${rounded > 0 ? '+' : ''}${rounded}`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function readWaveform(buffer: Float32Array<ArrayBuffer>) {
  const waveform = new Array<number>(WAVE_SAMPLES)
  const stride = Math.max(1, Math.floor(buffer.length / WAVE_SAMPLES))

  for (let index = 0; index < WAVE_SAMPLES; index += 1) {
    waveform[index] = clamp(buffer[index * stride] ?? 0, -1, 1)
  }

  return waveform
}

function getRms(buffer: Float32Array) {
  let sum = 0

  for (let index = 0; index < buffer.length; index += 1) {
    const value = buffer[index]
    sum += value * value
  }

  return Math.sqrt(sum / buffer.length)
}

function getClosestNote(frequency: number) {
  let closest = NOTE_SETS[0]
  let centsOffset = Number.POSITIVE_INFINITY

  for (const note of NOTE_SETS) {
    const cents = 1200 * Math.log2(frequency / note.frequency)

    if (Math.abs(cents) < Math.abs(centsOffset)) {
      closest = note
      centsOffset = cents
    }
  }

  return {
    closestNote: closest,
    centsOffset,
  }
}

function pickNextNote(excludeId: string | null) {
  const pool = excludeId ? NOTE_SETS.filter((note) => note.id !== excludeId) : NOTE_SETS
  return pool[Math.floor(Math.random() * pool.length)]
}

export default function App() {
  const [mode, setMode] = useState<Mode>('free')
  const [showChart, setShowChart] = useState(false)
  const [micState, setMicState] = useState<MicState>('idle')
  const [micError, setMicError] = useState('')
  const [detection, setDetection] = useState<DetectionSnapshot>(EMPTY_DETECTION)
  const [challenge, setChallenge] = useState<ChallengeState>(EMPTY_CHALLENGE)
  const [waveform, setWaveform] = useState<number[]>(() => Array.from({ length: WAVE_SAMPLES }, () => 0))

  const deferredDetection = useDeferredValue(detection)
  const deferredWaveform = useDeferredValue(waveform)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const detectorRef = useRef<ReturnType<typeof PitchDetector.forFloat32Array> | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const dataRef = useRef<Float32Array<ArrayBuffer> | null>(null)
  const rafRef = useRef<number | null>(null)
  const modeRef = useRef<Mode>(mode)
  const micStateRef = useRef<MicState>(micState)
  const detectionRef = useRef<DetectionSnapshot>(detection)
  const challengeRef = useRef<ChallengeState>(challenge)
  const deadlineRef = useRef<number | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const resultPauseRef = useRef<number | null>(null)

  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  useEffect(() => {
    micStateRef.current = micState
  }, [micState])

  useEffect(() => {
    detectionRef.current = detection
  }, [detection])

  useEffect(() => {
    challengeRef.current = challenge
  }, [challenge])

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
      }

      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current)
      }

      if (resultPauseRef.current !== null) {
        window.clearTimeout(resultPauseRef.current)
      }

      mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
      void audioContextRef.current?.close()
    }
  }, [])

  const targetNote = useMemo(
    () => NOTE_SETS.find((note) => note.id === challenge.targetId) ?? null,
    [challenge.targetId],
  )

  const detectionState = useMemo(() => {
    const stablePitch =
      deferredDetection.frequency >= MIN_FREQUENCY &&
      deferredDetection.frequency <= MAX_FREQUENCY &&
      deferredDetection.clarity >= CLARITY_GATE &&
      deferredDetection.volume >= VOLUME_GATE

    if (!stablePitch || !deferredDetection.closestNote || deferredDetection.centsOffset === null) {
      return {
        note: '--',
        frequency: '--',
        cents: '--',
        gauge: 0.5,
        hit: false,
        ready: false,
      }
    }

    const cents = deferredDetection.centsOffset
    const hit = Math.abs(cents) <= HIT_TOLERANCE_CENTS
    const gauge = clamp((cents + 50) / 100, 0, 1)

    return {
      note: deferredDetection.closestNote.label,
      frequency: deferredDetection.frequency.toFixed(1),
      cents: formatSignedCents(cents),
      gauge,
      hit,
      ready: true,
    }
  }, [deferredDetection])

  const wavePath = useMemo(() => {
    return deferredWaveform
      .map((point, index) => {
        const x = (index / Math.max(1, deferredWaveform.length - 1)) * 100
        const y = 50 - point * 38
        return `${x},${y}`
      })
      .join(' ')
  }, [deferredWaveform])

  function clearRoundTimers() {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }

    if (resultPauseRef.current !== null) {
      window.clearTimeout(resultPauseRef.current)
      resultPauseRef.current = null
    }
  }

  function getTargetCentsOffset(frequency: number) {
    const target = NOTE_SETS.find((note) => note.id === challengeRef.current.targetId)
    if (!target) {
      return null
    }

    return 1200 * Math.log2(frequency / target.frequency)
  }

  function finishRound(success: boolean, centsOffset: number | null) {
    const current = challengeRef.current

    if (current.phase !== 'listening') {
      return
    }

    clearRoundTimers()
    deadlineRef.current = null

    const resultText = success
      ? `Hit. ${formatSignedCents(centsOffset)} cents from center.`
      : `Missed. ${centsOffset === null ? 'No stable pitch detected.' : `${formatSignedCents(centsOffset)} cents off the target.`}`

    setChallenge((previous) => ({
      ...previous,
      phase: 'result',
      score: success ? previous.score + 1 : previous.score,
      lastResult: resultText,
      secondsLeft: 0,
    }))

    resultPauseRef.current = window.setTimeout(() => {
      if (modeRef.current !== 'challenge' || micStateRef.current !== 'listening') {
        return
      }

      startRound()
    }, RESULT_PAUSE_MS)
  }

  function startRound() {
    clearRoundTimers()

    const next = pickNextNote(challengeRef.current.targetId)
    const deadline = Date.now() + ROUND_DURATION_MS
    deadlineRef.current = deadline

    setChallenge((previous) => ({
      ...previous,
      phase: 'listening',
      targetId: next.id,
      round: previous.round + 1,
      secondsLeft: ROUND_DURATION_MS / 1000,
      lastResult: `Round ${previous.round + 1}: match ${next.instrumentName}.`,
    }))

    timeoutRef.current = window.setTimeout(() => {
      const latest = detectionRef.current
      finishRound(false, latest.frequency ? getTargetCentsOffset(latest.frequency) : null)
    }, ROUND_DURATION_MS)
  }

  async function startListening() {
    if (micState === 'requesting' || micState === 'listening') {
      return
    }

    if (!window.isSecureContext) {
      setMicState('error')
      setMicError('Microphone needs HTTPS on iPhone/iPad. Open this app over HTTPS or localhost.')
      return
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setMicState('error')
      setMicError('This browser does not expose microphone access here. On iPhone/iPad, use Safari over HTTPS.')
      return
    }

    try {
      setMicState('requesting')
      setMicError('')

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })

      const audioContext = new AudioContext()
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = INPUT_LENGTH * 2
      analyser.smoothingTimeConstant = 0.1
      source.connect(analyser)

      const detector = PitchDetector.forFloat32Array(INPUT_LENGTH)
      detector.clarityThreshold = CLARITY_GATE
      detector.minVolumeAbsolute = VOLUME_GATE

      audioContextRef.current = audioContext
      analyserRef.current = analyser
      detectorRef.current = detector
      mediaStreamRef.current = stream
      dataRef.current = new Float32Array(new ArrayBuffer(INPUT_LENGTH * Float32Array.BYTES_PER_ELEMENT))

      const tick = () => {
        const analyserNode = analyserRef.current
        const buffer = dataRef.current
        const detectorNode = detectorRef.current
        const context = audioContextRef.current

        if (!analyserNode || !buffer || !detectorNode || !context) {
          return
        }

        analyserNode.getFloatTimeDomainData(buffer)

        const volume = getRms(buffer)
        const [frequency, clarity] = detectorNode.findPitch(buffer as ArrayLike<number>, context.sampleRate)
        let snapshot = EMPTY_DETECTION

        if (
          frequency >= MIN_FREQUENCY &&
          frequency <= MAX_FREQUENCY &&
          clarity >= CLARITY_GATE &&
          volume >= VOLUME_GATE
        ) {
          const { closestNote, centsOffset } = getClosestNote(frequency)

          snapshot = {
            frequency,
            clarity,
            volume,
            closestNote,
            centsOffset,
          }
        }

        detectionRef.current = snapshot
        startTransition(() => {
          setDetection(snapshot)
          setWaveform(readWaveform(buffer))
        })

        const liveChallenge = challengeRef.current
        if (
          modeRef.current === 'challenge' &&
          liveChallenge.phase === 'listening' &&
          snapshot.closestNote &&
          snapshot.centsOffset !== null &&
          liveChallenge.targetId === snapshot.closestNote.id &&
          Math.abs(snapshot.centsOffset) <= HIT_TOLERANCE_CENTS
        ) {
          finishRound(true, snapshot.centsOffset)
        }

        rafRef.current = window.requestAnimationFrame(tick)
      }

      rafRef.current = window.requestAnimationFrame(tick)
      setMicState('listening')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Microphone access failed.'
      setMicState('error')
      setMicError(message)
    }
  }

  async function stopListening() {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }

    clearRoundTimers()
    deadlineRef.current = null
    setChallenge(EMPTY_CHALLENGE)
    setDetection(EMPTY_DETECTION)
    setWaveform(Array.from({ length: WAVE_SAMPLES }, () => 0))

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    mediaStreamRef.current = null

    if (audioContextRef.current) {
      await audioContextRef.current.close()
      audioContextRef.current = null
    }

    analyserRef.current = null
    detectorRef.current = null
    dataRef.current = null
    setMicState('idle')
  }

  useEffect(() => {
    if (mode !== 'challenge') {
      clearRoundTimers()
      deadlineRef.current = null
      setChallenge(EMPTY_CHALLENGE)
    }
  }, [mode])

  useEffect(() => {
    if (mode === 'challenge' && micState === 'listening' && challenge.phase === 'idle') {
      startRound()
    }
  }, [challenge.phase, micState, mode])

  useEffect(() => {
    if (mode !== 'challenge' || challenge.phase !== 'listening' || deadlineRef.current === null) {
      return
    }

    const interval = window.setInterval(() => {
      const deadline = deadlineRef.current
      if (deadline === null) {
        return
      }

      setChallenge((previous) => ({
        ...previous,
        secondsLeft: Math.max(0, (deadline - Date.now()) / 1000),
      }))
    }, 50)

    return () => {
      window.clearInterval(interval)
    }
  }, [challenge.phase, mode])

  const accuracy: 'hit' | 'close' | 'off' | 'idle' = !detectionState.ready
    ? 'idle'
    : detectionState.hit
      ? 'hit'
      : Math.abs(deferredDetection.centsOffset ?? 50) <= 40
        ? 'close'
        : 'off'

  const challengeFlash =
    mode === 'challenge' && challenge.phase === 'result'
      ? challenge.lastResult.startsWith('Hit')
        ? 'flash-hit'
        : 'flash-miss'
      : ''

  return (
    <main className="shell" data-accuracy={accuracy}>
      <div className="top-bar">
        <div className="mode-toggle" role="tablist" aria-label="Practice mode">
          <button
            className={mode === 'free' ? 'mode-btn active' : 'mode-btn'}
            onClick={() => setMode('free')}
            type="button"
          >
            Free
          </button>
          <button
            className={mode === 'challenge' ? 'mode-btn active' : 'mode-btn'}
            onClick={() => setMode('challenge')}
            type="button"
          >
            Challenge
          </button>
        </div>
        <button
          className={showChart ? 'chart-toggle chart-toggle-active' : 'chart-toggle'}
          onClick={() => setShowChart((v) => !v)}
          type="button"
          aria-label="Fingering chart"
        >
          ?
        </button>
        <button
          className={micState === 'listening' ? 'mic-btn mic-btn-active' : 'mic-btn'}
          onClick={micState === 'listening' ? stopListening : startListening}
          type="button"
        >
          {micState === 'requesting' ? '…' : micState === 'listening' ? 'Stop' : 'Start'}
        </button>
      </div>

      {showChart && (
        <div className="fingering-chart">
          {NOTE_SETS.map((note) => {
            const holes = FINGERINGS[note.id]
            const isActive = detectionState.ready && detectionState.note === note.label
            return (
              <div key={note.id} className={`chart-note ${isActive ? 'chart-note-active' : ''}`}>
                <span className="chart-name">{note.instrumentName}</span>
                <div className="chart-holes">
                  {holes?.map((covered, i) => (
                    <span key={i} className={covered ? 'hole hole-closed' : 'hole hole-open'} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <section className={`minimal-stage ${challengeFlash}`}>
        {mode === 'challenge' && (
          <div className="meta-line">
            <span>
              {challenge.phase === 'listening'
                ? `Play ${targetNote?.instrumentName ?? '—'}`
                : challenge.phase === 'result'
                  ? ''
                  : ''}
            </span>
            <span>
              {challenge.phase === 'listening'
                ? `${Math.ceil(challenge.secondsLeft)}s`
                : ''}
            </span>
            <span>{challenge.score > 0 ? `${challenge.score} ✓` : ''}</span>
          </div>
        )}

        <div className="note-core">
          <div className={accuracy === 'hit' ? 'note-ring note-ring-hit' : 'note-ring'} />
          <strong className={`note-label note-label-${accuracy}`}>
            {micState === 'listening' ? detectionState.note : '—'}
          </strong>
          <p className="note-sub">
            {micState !== 'listening'
              ? ''
              : !detectionState.ready
                ? ''
                : `${detectionState.cents} ¢`}
          </p>
        </div>

        <div className="gauge" aria-hidden="true">
          <div className="gauge-track" />
          <div className="gauge-center" />
          <div
            className={`gauge-dot gauge-dot-${accuracy}`}
            style={{ left: `${detectionState.gauge * 100}%` }}
          />
          <span className="gauge-label gauge-label-left">♭</span>
          <span className="gauge-label gauge-label-right">♯</span>
        </div>

        <div className="wave-wrap">
          <svg className="wave" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polyline className="wave-line" points={wavePath} />
          </svg>
        </div>

        {mode === 'challenge' && challenge.phase === 'result' ? (
          <div className={`result-line ${challenge.lastResult.startsWith('Hit') ? 'result-hit' : 'result-miss'}`}>
            {challenge.lastResult.startsWith('Hit') ? '●' : '○'}
          </div>
        ) : null}
        {micError ? <div className="error-line">{micError}</div> : null}
      </section>
    </main>
  )
}
