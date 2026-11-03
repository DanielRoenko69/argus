import { describe, it, expect, jest, beforeEach } from '@jest/globals';
const createEmbedding = jest.fn(async (_model: string, _input: string | string[]) => ({
  data: [{ embedding: [0.1, 0.2, 0.3] }],
}));
jest.mock('../../llm/client.js', () => ({
  createEmbedding,
  chatCompletion: jest.fn(),
  firstText: jest.fn(),
}));
jest.mock('../../lib/redis.js', () => ({ getRedisClient: () => null }));
import { embedText } from '../ragClient.js';

describe('embedText', () => {
  beforeEach(() => {
    createEmbedding.mockClear();
  });
  it('uses the direct embedding client and returns the vector', async () => {
    const vec = await embedText('hello');
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(createEmbedding).toHaveBeenCalledWith('text-embedding-3-large', 'hello');
  });
});
