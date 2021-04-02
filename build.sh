#!/bin/bash

ARCH=$(docker version --format '{{.Server.Arch}}')

if [ "$ARCH" = "arm" ]; then
    ARCH=arm32v7
fi

if [ "$#" -gt 1 ]; then
    TAG=$1-$2-$ARCH
    VARIANT=$2.
elif [ "$#" -gt 0 ]; then
    TAG=$1-$ARCH
else
    echo "Usage: $0 <version> <variant>"
    exit 1
fi

echo $TAG
echo ${VARIANT}Dockerfile

docker build --rm -t theappgineer/roon-extension-manager:$TAG -f ${VARIANT}Dockerfile .

if [ $? -eq 0 ]; then
    docker push theappgineer/roon-extension-manager:$TAG
fi
