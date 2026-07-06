/**
 * One-shot ingest — `npm run ingest [-- --source=<id>]`.
 * TODO(data-eng): registry → enabled sources → pipeline per source.
 */
const sourceArg = process.argv.find((a) => a.startsWith('--source='));

console.log(
  `[ingest] not yet implemented (data-eng): one-shot ingest${
    sourceArg ? ` for ${sourceArg.split('=')[1]}` : ' for all enabled sources'
  } — docs/ARCHITECTURE.md §8`,
);
console.log('[ingest] demo data comes from `npm run seed` until this lands.');
process.exit(0);
