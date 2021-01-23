FROM node:12.16.3-alpine

COPY manager.js installer-lib.js docker-lib.js package.json LICENSE /home/worker/

WORKDIR /home/worker

RUN adduser -D -s /bin/sh -h /home/worker worker && \
    apk add --no-cache tzdata git && \
    npm install && \
    apk del git && \
    mkdir -p .rem && \
    ln -s .rem/config.json config.json && \
    chown -R worker:worker . && \
    rm -rf /root/.npm/ && \
    rm -rf /usr/local/lib/node_modules/ && \
    rm -rf /usr/local/bin/np*

USER worker

CMD [ "node", "." ]
