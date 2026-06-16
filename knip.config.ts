export default {
  entry: ['src/index.ts', 'src/lib/types.ts'],
  includeEntryExports: false,
  ignoreDependencies: [/^@semantic-release\//],
};
