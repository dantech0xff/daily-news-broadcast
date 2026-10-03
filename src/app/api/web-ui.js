/**
 * Static dashboard UI (`web/dist`, built by Vite) with SPA fallback. It is
 * mounted behind Access authentication and the `viewer` role like the API:
 * reaching the origin without a valid token never returns the UI.
 *
 * - Existing files are served with `Cache-Control: private, no-cache`
 *   (revalidated every time, never stored by shared caches).
 * - `GET`/`HEAD` of a path without a file extension returns `index.html`
 *   (client-side routes); a missing asset is a 404.
 * - Without a build (`index.html` missing) every UI route answers 503 with a
 *   short "UI chưa được build" page; the API keeps working.
 */

import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import express from 'express';

import { htmlPage } from './errors.js';

const UI_CACHE_CONTROL = 'private, no-cache';
const ASSET_PATH = /\.[A-Za-z0-9]+$/;
const UI_NOT_BUILT_PAGE = htmlPage(
  'UI chưa được build',
  'Giao diện dashboard chưa được build (thiếu web/dist). API vẫn hoạt động; hãy build web rồi tải lại trang.',
);

/**
 * @param {{ webDir: string }} options Directory holding `index.html` and assets.
 * @returns {import('express').RequestHandler[]}
 */
export function createWebUi({ webDir }) {
  if (typeof webDir !== 'string' || webDir === '') throw new TypeError('createWebUi requires a web directory');
  const root = resolve(webDir);
  const indexFile = join(root, 'index.html');
  const assets = express.static(root, {
    index: false,
    redirect: false,
    dotfiles: 'ignore',
    setHeaders: res => res.set('Cache-Control', UI_CACHE_CONTROL),
  });

  /** @type {import('express').RequestHandler} */
  function spaFallback(req, res, next) {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || ASSET_PATH.test(req.path)) {
      next();
      return;
    }
    if (!isFile(indexFile)) {
      res.status(503).set('Cache-Control', 'no-store').type('html').send(UI_NOT_BUILT_PAGE);
      return;
    }
    res.set('Cache-Control', UI_CACHE_CONTROL);
    res.sendFile(indexFile, error => {
      if (error && !res.headersSent) next(error);
    });
  }

  return [assets, spaFallback];
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
