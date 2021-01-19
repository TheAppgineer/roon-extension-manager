# build_hw: use 'intel-nuc' for amd64, 'rpi' for arm32v6
ARG build_hw=intel-nuc

FROM balenalib/${build_hw}-debian:buster

RUN useradd -ms /bin/bash worker && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    nodejs \
    tzdata

WORKDIR /home/worker

COPY manager.js package.json LICENSE /home/worker/

RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git npm && \
    npm install && \
    apt-get autoremove -y git npm && \
    mkdir -p .rem && \
    ln -s .rem/config.json config.json && \
    chown -R worker:worker .

USER worker

CMD [ "node", "." ]
