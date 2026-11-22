// A fake GitHub for the update checks (as Lumen's tools/e2e/FakeServers): the releases API of the private
// CreeperUX/CreeperUX-Music, answering only with the token "gh-token". It lists 9.9.0, a test version 9.10.0-beta.1 and
// a draft; each installer is a few hundred KB of bytes whose SHA-256 the listing carries ("digest", as GitHub's).
// An asset's API address answers with a redirect to its storage, as GitHub's does, and the storage must not see the
// token. Nothing here is a real installer: test instances only download and check it.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

export const TOKEN = 'gh-token';
const REPO = '/repos/CreeperUX/CreeperUX-Music';

/** The bytes of a fake installer (different for every name). */
export function fakeSetup(name) {
  const line = Buffer.from(`MZ fake installer ${name} `);
  return Buffer.concat(Array.from({ length: Math.ceil(300_000 / line.length) }, () => line));
}

const sha256 = b => createHash('sha256').update(b).digest('hex');

export async function startFakeGitHub() {
  const log = { requests: [], tokenLeaked: false };
  let assets = [];
  const release = (tag, version, { prerelease = false, draft = false } = {}) => ({
    tag_name: tag, name: `CreeperUX Music ${tag.slice(1)}`, draft, prerelease, published_at: '2026-11-20T08:00:00Z',
    body: `## CreeperUX Music ${tag.slice(1)}\n\n**测试用的版本说明。**\n\n| 文件 | 说明 |\n|---|---|\n| \`CreeperUX-Music-${version}-x64-setup.exe\` | 安装程序 |\n\n- 第一条\n- 第二条，见 [说明](https://example.com)`,
    assets: ['x64', 'ARM64'].map(arch => {
      const name = `CreeperUX-Music-${version}-${arch}-setup.exe`;
      const id = assets.push(name);
      return { name, size: fakeSetup(name).length, url: `${base}${REPO}/releases/assets/${id}`, digest: `sha256:${sha256(fakeSetup(name))}` };
    }),
  });

  let base = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    log.requests.push({ path: url.pathname, auth: req.headers.authorization ?? null, accept: req.headers.accept ?? null });
    if (url.pathname.startsWith('/storage/')) {
      // the signed storage address: no token wanted, and none must arrive
      if (req.headers.authorization) log.tokenLeaked = true;
      const name = decodeURIComponent(url.pathname.slice('/storage/'.length));
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(fakeSetup(name));
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"message":"Bad credentials"}');
      return;
    }
    if (url.pathname === `${REPO}/releases`) {
      assets = [];
      const list = [release('v10.0.0', '10.0.0', { draft: true }), release('v9.10.0-beta.1', '9.10.0', { prerelease: true }), release('v9.9.0', '9.9.0')];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list));
      return;
    }
    const asset = url.pathname.match(new RegExp(`^${REPO}/releases/assets/(\\d+)$`));
    if (asset && assets[Number(asset[1]) - 1]) {
      res.writeHead(302, { location: `${base}/storage/${encodeURIComponent(assets[Number(asset[1]) - 1])}` }).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
  return { url: `${base}/`, log, sha256: name => sha256(fakeSetup(name)), stop: () => server.close() };
}
