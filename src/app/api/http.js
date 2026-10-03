/**
 * HTTP guards shared by the app routes: security headers, `no-store`,
 * same-origin and JSON checks for mutations, bounded JSON bodies, and strict
 * body/query readers.
 */

import express from 'express';

import { IssueCollector, ValidationError, readObject } from '../channels/validation.js';
import { ApiError } from './errors.js';

/** Default JSON body limit for mutations. */
export const DEFAULT_JSON_LIMIT = '8kb';
/** Channel create/update bodies carry prompts of up to 8,000 characters (~24 KB of Vietnamese UTF-8). */
export const CHANNEL_JSON_LIMIT = '64kb';

/**
 * Content Security Policy for the dashboard: same-origin scripts, styles,
 * and connections only (no inline scripts or styles); images and fonts may
 * also be inlined `data:` URIs as emitted by Vite.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
});

/** @type {import('express').RequestHandler} */
export function securityHeaders(_req, res, next) {
  res.set(SECURITY_HEADERS);
  next();
}

/** @type {import('express').RequestHandler} */
export function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

/**
 * Credential routes: unexpected failures are logged without their message.
 * @type {import('express').RequestHandler}
 */
export function markSensitive(_req, res, next) {
  res.locals.sensitive = true;
  next();
}

/**
 * Mutations must come from the dashboard's own origin (`PUBLIC_ORIGIN`).
 * @param {string} publicOrigin Normalized origin.
 * @returns {import('express').RequestHandler}
 */
export function requireSameOrigin(publicOrigin) {
  if (typeof publicOrigin !== 'string' || publicOrigin === '') throw new TypeError('requireSameOrigin requires an origin');
  return (req, _res, next) => {
    next(normalizeOrigin(req.headers.origin) === publicOrigin ? undefined : new ApiError(403, 'same_origin_required'));
  };
}

/**
 * Mutations must declare `Content-Type: application/json`, which also forces
 * a CORS preflight for any cross-site attempt.
 * @type {import('express').RequestHandler}
 */
export function requireJsonContent(req, _res, next) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  next(type === 'application/json' ? undefined : new ApiError(415, 'unsupported_media_type'));
}

/**
 * Strict JSON body parser (objects and arrays only).
 * @param {string} limit For example `8kb`.
 * @returns {import('express').RequestHandler}
 */
export function jsonBody(limit) {
  return express.json({ limit, strict: true, type: 'application/json' });
}

/**
 * Read a JSON body that must be an object with only `allowed` keys. A
 * missing body reads as `{}`.
 * @param {unknown} body
 * @param {readonly string[]} allowed
 * @returns {Record<string, unknown>} Only the allowed keys that are present.
 * @throws {ValidationError}
 */
export function readBody(body, allowed) {
  if (body === undefined) return {};
  const issues = new IssueCollector();
  const value = readObject(issues, body, '', { allowed });
  if (issues.hasIssues || !value) throw new ValidationError('Request body is invalid', issues.issues);
  return Object.fromEntries(allowed.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

/**
 * Copy the listed query parameters that are present; others are ignored.
 * @param {Record<string, unknown>} query
 * @param {readonly string[]} keys
 * @returns {Record<string, unknown>}
 */
export function pickQuery(query, keys) {
  return Object.fromEntries(keys.filter(key => query?.[key] !== undefined).map(key => [key, query[key]]));
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || value === '' || value === 'null') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}
