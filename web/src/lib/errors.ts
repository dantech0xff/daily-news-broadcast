/** Human-readable (Vietnamese) descriptions of API failures for toasts and error panels. */

import { ApiError } from '../api/client';
import type { ApiIssue } from '../api/types';
import { CREDENTIAL_SLOT_LABELS, labelOf } from './labels';

const UNEXPECTED_ERROR = 'Đã xảy ra lỗi không mong muốn.';
const MAX_ISSUE_LINES = 5;

/** 409 of resume, manual runs, and output retries while a cutover channel has no `notBefore`. */
export const CUTOVER_REQUIRED_CODE = 'cutover_required';
const CUTOVER_REQUIRED_HINT = 'Mở trang cấu hình kênh, đặt mốc ở mục Cutover rồi thử lại.';

export function isCutoverRequiredError(error: unknown): boolean {
  return error instanceof ApiError && error.code === CUTOVER_REQUIRED_CODE;
}

export interface ErrorDescription {
  title: string;
  lines: string[];
}

export function describeError(error: unknown): ErrorDescription {
  if (!(error instanceof ApiError)) return { title: UNEXPECTED_ERROR, lines: [] };
  const lines = error.issues.slice(0, MAX_ISSUE_LINES).map(formatIssue);
  if (error.issues.length > MAX_ISSUE_LINES) lines.push(`… và ${error.issues.length - MAX_ISSUE_LINES} lỗi khác.`);
  const details = error.details ?? {};
  if (Array.isArray(details.fields) && details.fields.length > 0) {
    lines.push(`Còn thiếu: ${details.fields.map(field => labelOf(CREDENTIAL_SLOT_LABELS, String(field))).join(', ')}.`);
  }
  if (Array.isArray(details.usedBy) && details.usedBy.length > 0) {
    lines.push(`Đang được dùng bởi kênh: ${details.usedBy.map(String).join(', ')}.`);
  }
  if (typeof details.unresolved === 'number') lines.push(`Còn ${details.unresolved} mục chưa xử lý xong.`);
  if (typeof details.currentVersion === 'number') lines.push(`Phiên bản hiện tại trên máy chủ: ${details.currentVersion}.`);
  if (typeof details.reason === 'string' && details.reason !== '') lines.push(`Chi tiết: ${details.reason}`);
  if (error.code === CUTOVER_REQUIRED_CODE) lines.push(CUTOVER_REQUIRED_HINT);
  return { title: error.message, lines };
}

export function formatIssue(issue: ApiIssue): string {
  return issue.field ? `${issue.field}: ${issue.message}` : issue.message;
}

/** Field errors keyed by the API's dotted paths (first message per field wins). */
export function issuesToFieldErrors(issues: readonly ApiIssue[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.field || '';
    if (!(key in errors)) errors[key] = issue.message;
  }
  return errors;
}
