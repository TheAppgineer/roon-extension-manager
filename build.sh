#!/bin/bash

if [ "$#" -eq 0 ]; then
    ARCH=$(docker version --format '{{.Server.Arch}}')

    if [ "$ARCH" = "amd64" ]; then
        TAG=v1.x-amd64
    elif [ "$ARCH" = "arm" ]; then
        TAG=v1.x-arm32v7
    else
        echo "Unsupported architecture"
        exit 1
    fi
else
    if [ "$#" -ge 2 ]; then
        TAG=$1-$2
        VARIANT=$2.
    else
        TAG=$1
    fi
fi

echo $TAG
echo ${VARIANT}Dockerfile

docker build --rm -t theappgineer/roon-extension-manager:$TAG -f ${VARIANT}Dockerfile .
docker push theappgineer/roon-extension-manager:$TAG
