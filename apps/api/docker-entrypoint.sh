#!/bin/bash -e

if [ "$UID" -eq 0 ]; then
  set +e # disable failing on errror
  ulimit -n 65535
  echo "NEW ULIMIT: $(ulimit -n)"
  set -e # enable failing on error
else
  echo ENTRYPOINT DID NOT RUN AS ROOT
fi

if [ "$FLY_PROCESS_GROUP" = "app" ]; then
  echo "RUNNING app"
  node dist/src/index.js
elif [ "$FLY_PROCESS_GROUP" = "worker" ]; then
  echo "RUNNING worker"
  node dist/src/services/queue-worker.js
elif [ "$FLY_PROCESS_GROUP" = "index-worker" ]; then
  echo "RUNNING index worker"
  node dist/src/services/indexing/index-worker.js
else
  echo "NO FLY PROCESS GROUP"
  node dist/src/index.js
fi
