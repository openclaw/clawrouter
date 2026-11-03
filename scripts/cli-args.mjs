export function parseArgs(values) {
  const out = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith("--")) {
      continue;
    }
    const name = value.slice(2);
    if (values[i + 1] && !values[i + 1].startsWith("--")) {
      out[name] = values[i + 1];
      i += 1;
    } else {
      out[name] = true;
    }
  }
  return out;
}

export function required(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

export function optionalValue(args, name) {
  const value = args[name];
  if (value === undefined) {
    return undefined;
  }
  if (value === true) {
    throw new Error(`--${name} requires a value`);
  }
  return value.trim();
}

export function requiredOption(args, name) {
  return required(optionalValue(args, name), `--${name}`);
}

export function setOptional(target, name, value) {
  if (value !== undefined) {
    target[name] = value;
  }
}
