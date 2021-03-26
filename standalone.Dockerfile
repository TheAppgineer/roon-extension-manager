FROM node:12.16.3-alpine

COPY manager.js installer-lib.js docker-lib.js package.json LICENSE /home/node/

WORKDIR /home/node

RUN apk add --no-cache tzdata git && \
    npm install && \
    apk del git && \
    mkdir -p .rem && \
    ln -s .rem/config.json config.json && \
    chown -R node:node . && \
    rm -rf /root/.npm/ && \
    rm -rf /usr/local/lib/node_modules/ && \
    rm -rf /usr/local/bin/np*

COPY etc /etc/

USER node

CMD [ "node", ".", "/etc/features.json" ]
