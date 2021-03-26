#!/bin/bash

if [ "$#" -gt 1 ]; then
    TAG=$1-$2
elif [ "$#" -gt 0 ]; then
    TAG=$1
else
    echo "Usage: $0 <version> <variant>"
    exit 1
fi

echo $TAG

docker pull theappgineer/roon-extension-manager:$TAG-arm32v7

docker manifest create theappgineer/roon-extension-manager:$TAG \
    theappgineer/roon-extension-manager:$TAG-amd64 \
    theappgineer/roon-extension-manager:$TAG-arm32v7

docker manifest annotate --arch arm --variant v7 theappgineer/roon-extension-manager:$TAG \
    theappgineer/roon-extension-manager:$TAG-arm32v7

docker manifest push --purge theappgineer/roon-extension-manager:$TAG
