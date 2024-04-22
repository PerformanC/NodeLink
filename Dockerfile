FROM node:alpine AS builder
WORKDIR /usr/src/app

COPY package*.json ./
COPY config.js ./
COPY constants.js ./
COPY src/ ./src/

RUN apk add --no-cache --virtual .build-deps npm git python3 make clang g++ \
    && npm install \
    && apk del .build-deps

FROM node:alpine

WORKDIR /usr/src/app

COPY --from=builder /usr/src/app .

RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production

CMD ["npm", "start"]
