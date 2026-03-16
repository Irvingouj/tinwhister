FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM joseluisq/static-web-server:2-alpine

ENV SERVER_ROOT=/home/sws/public
ENV SERVER_FALLBACK_PAGE=/index.html
ENV SERVER_HEALTH=true

COPY --from=build /app/dist /home/sws/public

EXPOSE 80
