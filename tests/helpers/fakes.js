import { AIPlugin, OutputPlugin, SourcePlugin } from '../../src/core/contracts.js';

export class RecordingSource extends SourcePlugin {
  constructor(articles = [], diagnostic = null) {
    super();
    this.articles = articles;
    this.diagnostic = diagnostic;
    this.calls = 0;
  }
  get id() { return 'recording-source'; }
  get name() { return 'Recording Source'; }
  async fetch() { this.calls += 1; return structuredClone(this.articles); }
  async fetchWithDiagnostics() {
    const articles = await this.fetch();
    return {
      articles,
      diagnostic: this.diagnostic ?? {
        status: articles.length ? 'success' : 'empty',
        articleCount: articles.length,
      },
    };
  }
}

export class RecordingAI extends AIPlugin {
  constructor(text = 'generated') { super(); this.text = text; this.calls = []; }
  get id() { return 'recording-ai'; }
  get name() { return 'Recording AI'; }
  async summarize(articles, options) {
    this.calls.push({ articles: structuredClone(articles), options: structuredClone(options) });
    return { text: this.text, usage: { input: 1, output: 1 }, model: 'fake' };
  }
}

export class RecordingOutput extends OutputPlugin {
  constructor({ key = 'recording:destination', results = [] } = {}) {
    super();
    this.key = key;
    this.results = [...results];
    this.calls = [];
  }
  get id() { return 'recording-output'; }
  get name() { return 'Recording Output'; }
  get deliveryKey() { return this.key; }
  async send(content, options) {
    this.calls.push({ content, options: structuredClone(options) });
    const result = this.results.shift();
    if (result instanceof Error) throw result;
    return result ?? {
      success: true,
      messageId: `message-${this.calls.length}`,
      meta: { deliveryState: 'success', retryDisposition: 'never' },
    };
  }
}
