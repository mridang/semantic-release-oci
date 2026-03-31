declare module '@semantic-release/error' {
  class SemanticReleaseError extends Error {
    code: string;
    details?: string;
    semanticRelease: boolean;
    constructor(message: string, code: string, details?: string);
  }
  export default SemanticReleaseError;
}
