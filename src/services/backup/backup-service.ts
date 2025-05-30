const result = await redisConnection.call('cf.scandump', cuckooFilterKey, iterator);

if (result === null && iterator === 0) {
  serviceLogger.warn(`cf.scandump for ${cuckooFilterKey} returned null data but iterator is 0. This might indicate end of scan for a non-empty filter that ended with an empty chunk, or an already empty filter.`);
} else if (result === null) {
  serviceLogger.warn(`No data returned from cf.scandump for ${cuckooFilterKey}. Filter might be empty.`);
}

await redisConnection.call('cf.reserve', cuckooFilterKey, capacity, 'BUCKETSIZE', bucketSize, 'MAXITERATIONS', maxIterations, 'EXPANSION', expansion);

const loadResult = await redisConnection.call('cf.loadchunk', cuckooFilterKey, chunk.iterator, chunkBuffer);
serviceLogger.info(`cf.loadchunk result for ${cuckooFilterKey} iterator ${chunk.iterator}: ${loadResult}`);

const info: any[] | null = await redisConnection.call('cf.info', cuckooFilterKey); 