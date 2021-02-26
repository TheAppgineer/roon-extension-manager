#!/bin/bash

docker pull theappgineer/roon-extension-manager:v1.x-arm32v7

docker manifest create theappgineer/roon-extension-manager:v1.x \
    theappgineer/roon-extension-manager:v1.x-amd64 \
    theappgineer/roon-extension-manager:v1.x-arm32v7

docker manifest annotate --arch arm --variant v7 theappgineer/roon-extension-manager:v1.x \
    theappgineer/roon-extension-manager:v1.x-arm32v7

docker manifest push --purge theappgineer/roon-extension-manager:v1.x
