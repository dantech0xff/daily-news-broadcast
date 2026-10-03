/**
 * The Dokploy API surface the deploy script uses, checked against the
 * OpenAPI document the instance serves (`settings.getOpenApiDocument`), and
 * request payloads fitted to that document.
 *
 * Dokploy fields drift between versions (`projectId` became `environmentId`
 * in v0.25), so nothing is assumed: preflight reports a missing procedure, a
 * missing field, or a newly required field as a blocker before anything is
 * changed. Optional fields are sent only when the instance knows them, and
 * the procedures and fields of one source (`DOKPLOY_SOURCE`) are checked
 * only when the deploy uses that source.
 */

/**
 * - `fields`: always sent and must exist on the instance (dotted paths are nested fields);
 * - `optional`: sent only when the instance schema has them;
 * - `source`: the procedure is called, and checked, only with that `DOKPLOY_SOURCE`;
 * - `sourceFields`: more `fields`, sent and checked only with that `DOKPLOY_SOURCE`.
 * @type {Readonly<Record<string, {
 *   method: 'GET'|'POST',
 *   fields: readonly string[],
 *   optional?: readonly string[],
 *   source?: 'git'|'github',
 *   sourceFields?: Readonly<Partial<Record<'git'|'github', readonly string[]>>>,
 * }>>}
 */
export const DOKPLOY_CALLS = Object.freeze({
  'project.all': { method: 'GET', fields: [] },
  'project.create': { method: 'POST', fields: ['name'], optional: ['description'] },
  'application.create': { method: 'POST', fields: ['name', 'environmentId'], optional: ['appName', 'description', 'serverId'] },
  'application.one': { method: 'GET', fields: ['applicationId'] },
  'application.saveGitProvider': {
    method: 'POST',
    fields: ['applicationId', 'customGitUrl', 'customGitBranch', 'customGitBuildPath'],
    optional: ['customGitSSHKeyId', 'watchPaths', 'enableSubmodules'],
    source: 'git',
  },
  // The GitHub App source: the provider, the repositories it can see, and the source itself.
  'github.githubProviders': { method: 'GET', fields: [], source: 'github' },
  'github.getGithubRepositories': { method: 'GET', fields: ['githubId'], source: 'github' },
  'application.saveGithubProvider': {
    method: 'POST',
    fields: ['applicationId', 'githubId', 'owner', 'repository', 'branch', 'buildPath', 'triggerType'],
    optional: ['watchPaths', 'enableSubmodules'],
    source: 'github',
  },
  'application.saveBuildType': {
    method: 'POST',
    fields: ['applicationId', 'buildType', 'dockerfile', 'dockerContextPath'],
    optional: ['dockerBuildStage', 'herokuVersion', 'railpackVersion', 'publishDirectory', 'isStaticSpa'],
  },
  'application.saveDockerProvider': { method: 'POST', fields: ['applicationId', 'dockerImage'], optional: ['username', 'password', 'registryUrl'] },
  'application.saveEnvironment': { method: 'POST', fields: ['applicationId', 'env'], optional: ['buildArgs', 'buildSecrets', 'createEnvFile'] },
  'mounts.create': { method: 'POST', fields: ['type', 'volumeName', 'mountPath', 'serviceId'], optional: ['serviceType'] },
  'application.update': {
    method: 'POST',
    fields: [
      'applicationId', 'replicas', 'args',
      'updateConfigSwarm.Parallelism', 'updateConfigSwarm.Order',
      'healthCheckSwarm.Test', 'healthCheckSwarm.Interval', 'healthCheckSwarm.Timeout', 'healthCheckSwarm.Retries',
    ],
    optional: ['healthCheckSwarm.StartPeriod'],
    // The GitHub source turns auto deploy back on when it is off.
    sourceFields: { github: ['autoDeploy'] },
  },
  'application.deploy': { method: 'POST', fields: ['applicationId'] },
  'application.redeploy': { method: 'POST', fields: ['applicationId'] },
  'deployment.all': { method: 'GET', fields: ['applicationId'] },
  'deployment.readLogs': { method: 'GET', fields: ['deploymentId'], optional: ['tail'] },
});

const STOP_GRACE_FIELD = /stop.?grace/i;
const MAX_DEPTH = 16;

/**
 * @typedef {object} DokployContract
 * @property {string[]} problems Drift that blocks the deploy.
 * @property {string[]} notes Optional fields the instance does not know (they are left out).
 * @property {string[]} procedures The procedures the deploy calls with this source; all of them are checked.
 * @property {{ field: string, types: string[] }|null} stopGrace Swarm stop grace period field of `application.update`, if any.
 * @property {(procedure: string, payload: Record<string, unknown>) => Record<string, unknown>} fit
 *   The payload with unsupported optional fields removed and `null` adapted to each field's schema.
 */

/**
 * @param {unknown} doc OpenAPI 3.x document.
 * @param {{ source?: 'git'|'github' }} [options] `source` (`DOKPLOY_SOURCE`, default `git`) selects
 *   the source-specific procedures and fields; the others are neither called nor checked.
 * @returns {DokployContract}
 */
export function analyzeDokployContract(doc, { source = 'git' } = {}) {
  const problems = [];
  const notes = [];
  const procedures = Object.keys(DOKPLOY_CALLS).filter(procedure => (DOKPLOY_CALLS[procedure].source ?? source) === source);
  /** @type {Map<string, object|null>} */
  const schemas = new Map();
  if (!doc || typeof doc !== 'object' || !doc.paths || typeof doc.paths !== 'object') {
    problems.push('The instance OpenAPI document has no paths; the API surface cannot be verified.');
    return { problems, notes, procedures, stopGrace: null, fit: (_procedure, payload) => payload };
  }

  for (const procedure of procedures) {
    const spec = DOKPLOY_CALLS[procedure];
    const fields = [...spec.fields, ...(spec.sourceFields?.[source] ?? [])];
    const pathItem = doc.paths[`/${procedure}`] ?? doc.paths[`/api/${procedure}`];
    if (!pathItem || typeof pathItem !== 'object') {
      problems.push(`${procedure} is missing (the deploy calls ${spec.method} /api/${procedure}).`);
      continue;
    }
    const operation = pathItem[spec.method.toLowerCase()];
    if (!operation) {
      const served = ['get', 'post', 'put', 'patch', 'delete'].filter(method => pathItem[method]).map(method => method.toUpperCase());
      problems.push(`${procedure} is served with ${served.join('/') || 'no method'}, but the deploy calls it with ${spec.method}.`);
      continue;
    }
    const schema = inputSchema(doc, operation, spec.method);
    schemas.set(procedure, schema);
    if (!schema) {
      problems.push(`${procedure} has no JSON input schema in the instance OpenAPI document, so its fields cannot be verified.`);
      continue;
    }
    for (const path of fields) {
      if (!schemaAt(doc, schema, path)) problems.push(`${procedure} has no field "${path}".`);
    }
    for (const path of spec.optional ?? []) {
      if (!schemaAt(doc, schema, path)) notes.push(`${procedure} has no optional field "${path}"; it is left out.`);
    }
    const sent = new Set([...fields, ...(spec.optional ?? [])]);
    const sentTop = new Set([...sent].map(path => path.split('.')[0]));
    // The Swarm stop grace period field is sent whenever the instance has one.
    if (procedure === 'application.update') {
      const graceField = stopGraceFieldOf(doc, schema);
      if (graceField) sentTop.add(graceField);
    }
    for (const required of requiredOf(doc, schema)) {
      if (!sentTop.has(required)) problems.push(`${procedure} requires "${required}", which the deploy does not send.`);
    }
    for (const parent of new Set([...sent].filter(path => path.includes('.')).map(path => path.split('.')[0]))) {
      const nested = schemaAt(doc, schema, parent);
      for (const required of nested ? requiredOf(doc, nested) : []) {
        if (!sent.has(`${parent}.${required}`)) problems.push(`${procedure} requires "${parent}.${required}", which the deploy does not send.`);
      }
    }
  }

  let stopGrace = null;
  const updateSchema = schemas.get('application.update');
  const graceField = updateSchema ? stopGraceFieldOf(doc, updateSchema) : null;
  if (graceField) stopGrace = { field: graceField, types: [...typesOf(doc, propertyOf(doc, updateSchema, graceField))] };

  return {
    problems,
    notes,
    procedures,
    stopGrace,
    fit(procedure, payload) {
      const schema = schemas.get(procedure);
      if (!schema) return payload;
      return fitObject(doc, schema, payload, new Set(DOKPLOY_CALLS[procedure]?.optional ?? []), '');
    },
  };
}

function stopGraceFieldOf(doc, schema) {
  return Object.keys(objectSchemaOf(doc, schema)?.properties ?? {}).find(name => STOP_GRACE_FIELD.test(name)) ?? null;
}

function inputSchema(doc, operation, method) {
  if (method === 'GET') {
    const parameters = (Array.isArray(operation.parameters) ? operation.parameters : [])
      .map(parameter => deref(doc, parameter))
      .filter(parameter => parameter?.in === 'query' && typeof parameter.name === 'string');
    return {
      type: 'object',
      properties: Object.fromEntries(parameters.map(parameter => [parameter.name, parameter.schema ?? {}])),
      required: parameters.filter(parameter => parameter.required === true).map(parameter => parameter.name),
    };
  }
  const body = deref(doc, operation.requestBody);
  return deref(doc, body?.content?.['application/json']?.schema);
}

function fitObject(doc, schema, value, optional, prefix) {
  const required = new Set(requiredOf(doc, schema));
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const property = propertyOf(doc, schema, key);
    if (!property) {
      // Optional fields the instance does not know are left out; required ones were reported by preflight.
      if (!optional.has(path)) result[key] = entry;
      continue;
    }
    if (entry === null) {
      if (acceptsNull(doc, property)) result[key] = null;
      else if (!required.has(key)) continue;
      else if (typesOf(doc, property).has('string')) result[key] = '';
      else result[key] = null;
      continue;
    }
    result[key] = isPlainObject(entry) && objectSchemaOf(doc, property)
      ? fitObject(doc, property, entry, optional, path)
      : entry;
  }
  return result;
}

function deref(doc, schema) {
  let current = schema;
  for (let hops = 0; current && typeof current === 'object' && typeof current.$ref === 'string'; hops += 1) {
    if (hops > MAX_DEPTH || !current.$ref.startsWith('#/')) return null;
    current = current.$ref.slice(2).split('/')
      .map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), doc);
  }
  return current && typeof current === 'object' ? current : null;
}

// The object form of a schema: merges `allOf` and picks the object branch of
// `anyOf`/`oneOf` (how nullable objects are usually expressed).
function objectSchemaOf(doc, schema, depth = 0) {
  const resolved = deref(doc, schema);
  if (!resolved || depth > MAX_DEPTH) return null;
  if (Array.isArray(resolved.allOf)) {
    const merged = { properties: { ...(resolved.properties ?? {}) }, required: [...(resolved.required ?? [])] };
    for (const part of resolved.allOf) {
      const object = objectSchemaOf(doc, part, depth + 1);
      if (object) {
        Object.assign(merged.properties, object.properties);
        merged.required.push(...(object.required ?? []));
      }
    }
    return merged;
  }
  if (resolved.properties && typeof resolved.properties === 'object') return resolved;
  for (const key of ['anyOf', 'oneOf']) {
    for (const variant of Array.isArray(resolved[key]) ? resolved[key] : []) {
      const object = objectSchemaOf(doc, variant, depth + 1);
      if (object) return object;
    }
  }
  return null;
}

function propertyOf(doc, schema, key) {
  const property = objectSchemaOf(doc, schema)?.properties?.[key];
  return property === undefined ? null : (deref(doc, property) ?? {});
}

function schemaAt(doc, schema, path) {
  let current = schema;
  for (const key of path.split('.')) {
    current = propertyOf(doc, current, key);
    if (!current) return null;
  }
  return current;
}

function requiredOf(doc, schema) {
  const required = objectSchemaOf(doc, schema)?.required;
  return Array.isArray(required) ? required.filter(name => typeof name === 'string') : [];
}

function acceptsNull(doc, schema, depth = 0) {
  const resolved = deref(doc, schema);
  if (!resolved || depth > MAX_DEPTH) return false;
  if (resolved.nullable === true || resolved.type === 'null' || (Array.isArray(resolved.type) && resolved.type.includes('null'))) return true;
  if (Array.isArray(resolved.enum) && resolved.enum.includes(null)) return true;
  return ['anyOf', 'oneOf'].some(key => Array.isArray(resolved[key]) && resolved[key].some(variant => acceptsNull(doc, variant, depth + 1)));
}

function typesOf(doc, schema, depth = 0, types = new Set()) {
  const resolved = deref(doc, schema);
  if (!resolved || depth > MAX_DEPTH) return types;
  for (const type of Array.isArray(resolved.type) ? resolved.type : [resolved.type]) {
    if (typeof type === 'string' && type !== 'null') types.add(type);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    for (const variant of Array.isArray(resolved[key]) ? resolved[key] : []) typesOf(doc, variant, depth + 1, types);
  }
  return types;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
