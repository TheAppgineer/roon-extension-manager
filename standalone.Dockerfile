ARG build_arch=amd64

FROM multiarch/alpine:${build_arch}-v3.12

RUN addgroup -g 1000 node && \
    adduser -u 1000 -G node -s /bin/sh -D node && \
    apk add --no-cache nodejs

WORKDIR /home/node

COPY manager.js installer-lib.js docker-lib.js docker-hub.js package.json LICENSE /home/node/

RUN apk add --no-cache tzdata g++ git linux-headers make cmake python3 npm && \
    npm install && \
    apk del g++ git linux-headers make cmake python3 npm && \
    mkdir -p .rem && \
    ln -s .rem/config.json config.json && \
    chown -R node:node .rem/

COPY etc /etc/

USER node

CMD [ "node", ".", "/etc/features.json" ]
