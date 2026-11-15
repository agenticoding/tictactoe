import http from 'node:http';

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Raw HTTP request capturing status, headers, and body. The existing `getJson`
 * (ws-helpers) discards all three, so it cannot assert SPA/static contracts.
 */
export function request(url: string, opts: { method?: string } = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method ?? 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}
