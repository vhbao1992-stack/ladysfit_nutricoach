#!/usr/bin/env node
/**
 * Tự động cập nhật mục "Cập Nhật Từ Huberman Lab" cho app Ladysfit NutriCoach.
 *
 * Chạy hằng tuần bằng GitHub Actions:
 *   1. Đọc trang all-episodes của Huberman Lab, lấy các tập chưa có trong app.
 *   2. Nhờ Claude đọc nội dung tập đó và viết thẻ kiến thức tiếng Việt.
 *   3. Chèn thẻ vào index.html và bổ sung kho kiến thức trong netlify/functions/chat.js.
 *   4. Tự kiểm tra cú pháp. Có lỗi là dừng, không ghi file hỏng.
 *
 * Biến môi trường: ANTHROPIC_API_KEY (bắt buộc), ANTHROPIC_MODEL (tuỳ chọn).
 */

import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';

const INDEX_FILE = 'index.html';
const CHAT_FILE = 'netlify/functions/chat.js';
const EPISODES_URL = 'https://www.hubermanlab.com/all-episodes';
const MODEL = (process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929').trim();
const MAX_NEW_CARDS = 2;          // mỗi tuần thêm tối đa 2 thẻ
const MAX_CANDIDATES = 6;         // xét tối đa 6 tập mới nhất

const log = (...a) => console.log('[huberman]', ...a);

/* ---------- tiện ích ---------- */

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'LadysfitNutriCoachBot/1.0 (+github-actions)' },
  });
  if (!res.ok) throw new Error(`Tải ${url} thất bại: HTTP ${res.status}`);
  return res.text();
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------- gọi Claude ---------- */

async function askClaude(apiKey, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API lỗi ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

function parseJsonLoose(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Claude không trả về JSON');
  return JSON.parse(text.slice(start, end + 1));
}

function buildPrompt(episodeUrl, episodeText) {
  return `Bạn đang viết nội dung cho app nội bộ "Ladysfit NutriCoach" — nơi các PT (huấn luyện viên cá nhân) của một phòng tập giảm cân DÀNH RIÊNG CHO NỮ tra cứu kiến thức dinh dưỡng.

Dưới đây là nội dung một tập podcast của Huberman Lab. Nhiệm vụ của bạn:

1. Quyết định tập này có LIÊN QUAN tới bối cảnh Ladysfit không. Liên quan nghĩa là nói về: giảm mỡ/cân nặng, dinh dưỡng, nội tiết tố nữ, tuyến giáp, đường ruột, giấc ngủ và phục hồi, viêm nhiễm, thói quen/hành vi ăn uống, tập luyện giữ cơ. Nếu KHÔNG liên quan (ví dụ: thị lực, thính giác, vật lý trị liệu chuyên sâu, chủ đề chính trị/xã hội), trả về {"skip": true}.

2. Nếu CÓ liên quan, viết một thẻ kiến thức bằng tiếng Việt ĐƠN GIẢN, DỄ HIỂU, để PT áp dụng ngay khi tư vấn hội viên nữ.

Trả về DUY NHẤT một object JSON, không kèm giải thích, theo đúng cấu trúc:

{
  "skip": false,
  "title": "Tiêu đề ngắn tiếng Việt, tối đa 60 ký tự",
  "tags": ["2-3 nhãn ngắn, ví dụ: Giảm mỡ, Đường ruột, Huberman"],
  "bodyHtml": "Nội dung HTML",
  "digest": ["1-2 dòng tóm tắt cực ngắn để nạp cho trợ lý AI, mỗi dòng một ý"]
}

QUY TẮC cho bodyHtml:
- Chỉ dùng các thẻ: <p>, <b>, <ul>, <li>, và nếu cần thì <div class="dose-row"><span class="dose">Tên: liều lượng</span></div> cho liều lượng cụ thể.
- Nếu có cảnh báo an toàn thì dùng: <div class="callout warn"><svg><use href="#i-warn"/></svg>Nội dung cảnh báo</div>
- Vấn đề y tế (bệnh nền, thuốc kê đơn, mang thai) BẮT BUỘC kèm lời khuyên gặp bác sĩ. Không đưa chẩn đoán y khoa.
- Độ dài khoảng 120-220 từ. Viết chữ thường tự nhiên, KHÔNG dùng ký hiệu markdown như # hay **.
- KHÔNG tự thêm dòng ghi nguồn, hệ thống sẽ tự thêm.
- Dùng &amp; thay cho dấu & trong văn bản.
- Chỉ viết những gì CÓ trong nội dung tập bên dưới. Tuyệt đối không bịa số liệu hay liều lượng.

Link tập: ${episodeUrl}

NỘI DUNG TẬP:
${episodeText.slice(0, 9000)}`;
}

/* ---------- chèn nội dung ---------- */

const CARD_ANCHOR = ' ]}\n];';

function insertCard(indexHtml, card, episodeUrl, episodeTitle) {
  const anchorAt = indexHtml.lastIndexOf(CARD_ANCHOR);
  if (anchorAt === -1) throw new Error('Không tìm thấy điểm chèn thẻ trong index.html');

  const tags = (card.tags || ['Huberman']).slice(0, 3).map((t) => JSON.stringify(String(t))).join(',');
  const safeTitle = JSON.stringify(String(card.title));
  const source = `<p class="source-line">Nguồn: <a href="${episodeUrl}" target="_blank" rel="noopener">Huberman Lab – ${escapeHtml(episodeTitle)}</a></p>`;

  const block = `,
  {title:${safeTitle}, tags:[${tags}],
   body:\`${card.bodyHtml.replace(/`/g, "'").replace(/\$\{/g, '${"${"}')}
   ${source}\`}`;

  return indexHtml.slice(0, anchorAt).replace(/\s*$/, '') + block + '\n' + indexHtml.slice(anchorAt);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const DIGEST_ANCHOR = '[HUBERMAN LAB - CẬP NHẬT KHOA HỌC THẦN KINH]';

function appendDigest(chatJs, lines) {
  const at = chatJs.indexOf(DIGEST_ANCHOR);
  if (at === -1) throw new Error('Không tìm thấy mục Huberman trong chat.js');
  const sectionEnd = chatJs.indexOf('\n`.trim();', at);
  if (sectionEnd === -1) throw new Error('Không xác định được cuối SYSTEM_PROMPT trong chat.js');
  const add = lines.map((l) => '- ' + String(l).replace(/[\r\n]+/g, ' ').trim()).join('\n');
  return chatJs.slice(0, sectionEnd) + '\n' + add + chatJs.slice(sectionEnd);
}

/* ---------- kiểm tra ---------- */

function checkSyntax(indexHtml, chatJs) {
  const m = indexHtml.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('Không tìm thấy thẻ script trong index.html');
  new vm.Script(m[1], { filename: 'index-inline.js' });   // chỉ biên dịch, không chạy
  new vm.Script(chatJs, { filename: 'chat.js' });
  if (!indexHtml.includes('id:"huberman"')) throw new Error('Mục huberman biến mất');
  if (!chatJs.includes('exports.handler')) throw new Error('chat.js hỏng cấu trúc');
}

/* ---------- luồng chính ---------- */

async function main() {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) throw new Error('Thiếu ANTHROPIC_API_KEY trong GitHub Secrets');

  let indexHtml = await readFile(INDEX_FILE, 'utf8');
  let chatJs = await readFile(CHAT_FILE, 'utf8');

  log('Đang đọc danh sách tập...');
  const listHtml = await fetchText(EPISODES_URL);
  const slugs = [...new Set([...listHtml.matchAll(/\/episode\/([a-z0-9-]+)/gi)].map((m) => m[1]))];
  log(`Tìm thấy ${slugs.length} tập trên trang.`);

  const candidates = slugs.filter((s) => !indexHtml.includes(`/episode/${s}`)).slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) {
    log('Không có tập nào mới so với app. Dừng.');
    return;
  }
  log(`Có ${candidates.length} tập chưa đưa vào app, đang xét...`);

  let added = 0;
  const summary = [];

  for (const slug of candidates) {
    if (added >= MAX_NEW_CARDS) break;
    const url = `https://www.hubermanlab.com/episode/${slug}`;
    let text;
    try {
      text = htmlToText(await fetchText(url));
    } catch (e) {
      log(`Bỏ qua ${slug}: ${e.message}`);
      continue;
    }
    if (text.length < 400) { log(`Bỏ qua ${slug}: nội dung quá ngắn.`); continue; }

    const epTitle = (text.match(/^(.{10,120}?)\s*\|/) || [])[1] || slug.replace(/-/g, ' ');

    let card;
    try {
      card = parseJsonLoose(await askClaude(apiKey, buildPrompt(url, text)));
    } catch (e) {
      log(`Bỏ qua ${slug}: ${e.message}`);
      continue;
    }
    if (card.skip || !card.bodyHtml || !card.title) { log(`Bỏ qua ${slug}: không liên quan Ladysfit.`); continue; }

    indexHtml = insertCard(indexHtml, card, url, epTitle);
    if (Array.isArray(card.digest) && card.digest.length) chatJs = appendDigest(chatJs, card.digest);
    added++;
    summary.push(`${card.title} (${url})`);
    log(`Đã thêm thẻ: ${card.title}`);
  }

  if (added === 0) { log('Không có tập nào phù hợp để thêm. Dừng, không sửa file.'); return; }

  checkSyntax(indexHtml, chatJs);
  await writeFile(INDEX_FILE, indexHtml);
  await writeFile(CHAT_FILE, chatJs);
  log(`Hoàn tất: thêm ${added} thẻ.`);
  console.log('SUMMARY::' + summary.join(' | '));
}

main().catch((err) => {
  console.error('[huberman] LỖI:', err.message);
  process.exit(1);
});
