// Finite edit targets for callers that use a structured-output model adapter.
export function createRegionEditSchema(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 64) throw new Error('invalid_region_targets');
  const paths = new Set(); let values = 0, characters = 0;
  const alternatives = Array.from(files, file => {
    if (!file || typeof file.path !== 'string' || !file.path.trim() || paths.has(file.path)
      || !Array.isArray(file.ids) || file.ids.length < 1) throw new Error('invalid_region_targets');
    paths.add(file.path);
    const ids = new Set();
    for (const id of file.ids) {
      if (typeof id !== 'string' || !id.trim() || ids.has(id)) throw new Error('invalid_region_targets');
      ids.add(id); characters += id.length;
    }
    values += ids.size + 1; characters += file.path.length;
    if (values > 1000 || characters > 100000
      || (ids.size > 250 && file.ids.reduce((n, id) => n + id.length, 0) > 15000)) throw new Error('region_schema_limit');
    return { type: 'object', additionalProperties: false, required: ['path', 'id', 'code'], properties: {
      path: { type: 'string', enum: [file.path] }, id: { type: 'string', enum: [...ids] }, code: { type: 'string' },
    } };
  });
  return { type: 'object', additionalProperties: false, required: ['edits'], properties: {
    edits: { type: 'array', minItems: 1, maxItems: 24,
      items: alternatives.length === 1 ? alternatives[0] : { anyOf: alternatives } },
  } };
}
