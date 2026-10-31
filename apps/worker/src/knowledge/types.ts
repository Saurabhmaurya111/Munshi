export type PolicyDocumentInput = {
  documentId: string;
  documentTitle: string;
  source: string;
  version: string;
  content: string;
  category?: string;
  language?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  metadata?: Record<string, unknown>;
};

export type PolicyChunkDraft = {
  chunkIndex: number;
  content: string;
};

export type ChunkOptions = {
  maxChars?: number;
  overlapChars?: number;
};

export type EmbeddedChunk = PolicyChunkDraft & {
  embedding: number[];
};

export type RetrievedChunk = {
  documentId: string;
  documentTitle: string;
  source: string;
  content: string;
  chunkIndex: number;
  documentVersion: string;
  category?: string;
  language: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  metadata: Record<string, unknown>;
  score: number;
};

export type Citation = {
  documentId: string;
  documentTitle: string;
  source: string;
  documentVersion: string;
  chunkIndex: number;
};

export type EmbeddingProvider = {
  dimensions: number;
  embed: (texts: string[]) => Promise<number[][]>;
};

export type SearchFilter = {
  asOf?: string;
  category?: string;
  language?: string;
  minScore?: number;
};

export type SearchOptions = SearchFilter & {
  limit: number;
};

export type PolicyChunkStore = {
  replaceDocument: (
    document: PolicyDocumentInput,
    chunks: EmbeddedChunk[],
  ) => Promise<number>;
  search: (embedding: number[], options: SearchOptions) => Promise<RetrievedChunk[]>;
};

export type IngestResult = {
  documentId: string;
  documentVersion: string;
  chunks: number;
};

export type RetrieveInput = {
  query: string;
  limit?: number;
  asOf?: string;
  category?: string;
  language?: string;
  minScore?: number;
};
