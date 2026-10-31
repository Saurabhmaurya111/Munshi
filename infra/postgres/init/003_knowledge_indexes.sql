CREATE INDEX IF NOT EXISTS policy_chunks_embedding_hnsw_idx
  ON policy_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS policy_chunks_filter_idx
  ON policy_chunks (category, language);
