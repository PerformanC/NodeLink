FROM node:lts-alpine
WORKDIR /usr/src/app

COPY . .

RUN apk add --no-cache ffmpeg python3 make clang g++ git

ENV NODE_ENV=production

RUN npm i

RUN apk --purge del python3 make clang g++ git

CMD ["npm", "start"]