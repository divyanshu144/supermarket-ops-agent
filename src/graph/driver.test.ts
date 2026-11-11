import { describe, expect, it } from 'vitest';
import neo4j from 'neo4j-driver';
import { readerSessionOptions } from './driver.js';

describe('graph reader session', () => {
  it('always selects Neo4j READ access mode', () => {
    expect(readerSessionOptions()).toEqual({
      database: 'neo4j',
      defaultAccessMode: neo4j.session.READ,
    });
  });
});
