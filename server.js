process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const LMS_BASE_URL = 'https://apps.ictu.edu.vn:9087/ionline/api';
const DEFAULT_APP_ID = '7040BD38-0D02-4CBE-8B0E-F4115C348003';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

/**
 * CRC32 Hash implementation for LMS ICTU
 */
function crc32(str) {
  const table = (() => {
    const t = [];
    for (let s = 0; s < 256; s++) {
      let c = s;
      for (let r = 0; r < 8; r++) c = (1 & c) ? (3988292384 ^ (c >>> 1)) : (c >>> 1);
      t[s] = c;
    }
    return t;
  })();

  let s = -1;
  for (let r = 0; r < str.length; r++) {
    s = (s >>> 8) ^ table[255 & (s ^ str.charCodeAt(r))];
  }
  return ((-1 ^ s) >>> 0).toString(16).toUpperCase();
}

/**
 * Generate GMT+7 real-time signing date: YYYY-MM-DD HH:mm:00
 */
function getSigningDate(d = new Date()) {
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const gmt7 = new Date(utc + (3600000 * 7));
  const pad = n => String(n).padStart(2, '0');
  return `${gmt7.getFullYear()}-${pad(gmt7.getMonth() + 1)}-${pad(gmt7.getDate())} ${pad(gmt7.getHours())}:${pad(gmt7.getMinutes())}:00`;
}

/**
 * Calculate dynamic x-request-signature
 */
function generateSignature(appId, method = 'GET', body = null) {
  const dateStr = getSigningDate();
  const bodyPart = (['POST', 'PUT'].includes(method.toUpperCase()) ? JSON.stringify(body ?? {}) : '');
  const rawString = bodyPart + appId + dateStr;
  return crc32(rawString);
}

/**
 * Universal Proxy Request Handler to ICTU LMS Backend
 */
async function callLmsApi(pathEndpoint, headers = {}, queryParams = {}, method = 'GET', body = null) {
  const cleanPath = pathEndpoint.replace(/^\/?(ionline\/api\/|api\/)?/, '');
  const url = new URL(`${LMS_BASE_URL}/${cleanPath}`);
  
  // Append query params
  Object.entries(queryParams).forEach(([k, v]) => {
    if (v !== undefined && v !== null) {
      url.searchParams.append(k, v);
    }
  });

  const appId = headers['x-app-id'] || DEFAULT_APP_ID;
  const signature = generateSignature(appId, method, body);

  const authHeader = headers['authorization'] || headers['Authorization'];

  const outgoingHeaders = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    'Origin': 'https://lms.ictu.edu.vn',
    'Referer': 'https://lms.ictu.edu.vn/',
    'Host': 'apps.ictu.edu.vn:9087',
    'X-APP-ID': appId,
    'x-request-signature': signature
  };

  if (authHeader) {
    outgoingHeaders['Authorization'] = authHeader.startsWith('Bearer ') ? authHeader : `Bearer ${authHeader}`;
  }

  try {
    const response = await fetch(url.toString(), {
      method: method.toUpperCase(),
      headers: outgoingHeaders,
      body: body ? JSON.stringify(body) : undefined,
      agent: httpsAgent
    });

    const resText = await response.text();
    let data;
    try {
      data = JSON.parse(resText);
    } catch {
      data = { raw: resText };
    }

    if (!response.ok || (data && data.code && data.code !== 'success' && data.code !== 200)) {
      return {
        error: data.message || `Lỗi máy chủ LMS: HTTP ${response.status}`,
        status: response.status,
        details: data
      };
    }

    return data;
  } catch (err) {
    return {
      error: `Lỗi kết nối máy chủ LMS: ${err.message}`
    };
  }
}

/**
 * 1. POST /api/process-headers
 */
app.post('/api/process-headers', async (req, res) => {
  const { headersText } = req.body;
  if (!headersText || typeof headersText !== 'string') {
    return res.status(400).json({ status: 'error', message: 'headersText không hợp lệ hoặc bị trống' });
  }

  const lines = headersText.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return res.status(400).json({ status: 'error', message: 'Chuỗi headers rỗng' });
  }

  const headers = {};
  let studentId = null;
  let classId = null;

  // Extract from query params if present
  for (const line of lines) {
    if (line.includes('?') || line.includes('condition')) {
      try {
        const queryIdx = line.indexOf('?');
        if (queryIdx > -1) {
          const queryString = line.substring(queryIdx + 1).split(' ')[0];
          const params = new URLSearchParams(queryString);
          for (const [key, val] of params.entries()) {
            if (key.includes('student_id')) studentId = parseInt(val);
            if (key.includes('class_id')) classId = parseInt(val);
          }
        }
      } catch (e) {
        console.error('Error parsing query params:', e);
      }
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx > -1) {
      const key = line.substring(0, colonIdx).trim().toLowerCase();
      const val = line.substring(colonIdx + 1).trim();
      headers[key] = val;
    }
  }

  const authKey = Object.keys(headers).find(k => k.toLowerCase() === 'authorization');
  if (!authKey || !headers[authKey]) {
    return res.status(400).json({
      status: 'error',
      message: 'Thiếu dòng "authorization" (Token đăng nhập). Vui lòng copy đầy đủ toàn bộ Request Headers từ F12 Network trên trang LMS!'
    });
  }

  // If studentId wasn't in URL, fetch user profile
  const profileRes = await callLmsApi('user-profile/', headers);
  if (profileRes.error) {
    return res.status(500).json({ status: 'error', message: `Lỗi kết nối LMS: ${profileRes.error}` });
  }
  
  if (profileRes.data && profileRes.data.length > 0) {
    studentId = profileRes.data[0].id;
  } else {
    return res.status(404).json({ status: 'error', message: 'Không tìm thấy thông tin sinh viên trong Token này.' });
  }

  return res.json({
    status: 'success',
    headers,
    studentId,
    classId,
    studentInfo: profileRes.data[0]
  });
});

/**
 * 2. POST /api/classes
 */
app.post('/api/classes', async (req, res) => {
  const { headers, studentId } = req.body;
  if (!studentId) {
    return res.status(400).json({ status: 'error', message: 'Thiếu studentId' });
  }

  const data = await callLmsApi('class-students/', headers, {
    limit: 1000,
    paged: 1,
    select: 'namhoc,hocky,class_id',
    'condition[0][key]': 'student_id',
    'condition[0][value]': studentId,
    'condition[0][compare]': '='
  });

  if (data.error) return res.status(500).json({ status: 'error', message: data.error });
  return res.json(data);
});

/**
 * 3. POST /api/class-details
 */
app.post('/api/class-details', async (req, res) => {
  const { headers, classId } = req.body;
  if (!classId) return res.status(400).json({ status: 'error', message: 'Thiếu classId' });

  const data = await callLmsApi(`class/${classId}`, headers, {
    with: 'managers'
  });

  if (data.error) return res.status(500).json({ status: 'error', message: data.error });
  return res.json(data);
});

/**
 * 4. POST /api/course-plan
 */
app.post('/api/course-plan', async (req, res) => {
  const { headers, classId } = req.body;
  if (!classId) return res.status(400).json({ status: 'error', message: 'Thiếu classId' });

  try {
    const data = await callLmsApi('class-plans/', headers, {
      limit: 1000,
      paged: 1,
      orderby: 'week',
      order: 'ASC',
      select: 'id,class_id,course_id,course_plan_activity_id,week,title,date_start_of_week,date_end_of_week,teaching_day',
      'condition[0][key]': 'class_id',
      'condition[0][value]': classId,
      'condition[0][compare]': '=',
      'condition[1][key]': 'week',
      'condition[1][value]': 1000,
      'condition[1][compare]': '<>'
    });

    if (data.error) {
      return res.json({ status: 'success', data: [] });
    }
    return res.json(data);
  } catch (e) {
    return res.json({ status: 'success', data: [] });
  }
});

/**
 * 5. POST /api/test-results
 */
app.post('/api/test-results', async (req, res) => {
  const { headers, classId, week } = req.body;
  if (!classId || week === undefined) {
    return res.status(400).json({ status: 'error', message: 'Thiếu classId hoặc week' });
  }

  const data = await callLmsApi('class-plan-activity-student-tests/', headers, {
    limit: 1000,
    paged: 1,
    order: 'ASC',
    orderby: 'id',
    'condition[0][key]': 'week',
    'condition[0][value]': week,
    'condition[0][compare]': '=',
    'condition[1][key]': 'class_id',
    'condition[1][value]': classId,
    'condition[1][compare]': '=',
    'condition[1][type]': 'and'
  });

  if (data.error) return res.status(500).json({ status: 'error', message: data.error });
  return res.json(data);
});

/**
 * 6. POST /api/test-details
 */
app.post('/api/test-details', async (req, res) => {
  const { headers, testId } = req.body;
  if (!testId) return res.status(400).json({ status: 'error', message: 'Thiếu testId' });

  const data = await callLmsApi('class-plan-activity-student-tests/', headers, {
    select: 'id,class_plan_activity_id,av,class_id,time,questions,course_id,status',
    with: 'test',
    'condition[0][key]': 'id',
    'condition[0][value]': testId,
    'condition[0][compare]': '='
  });

  if (data.error) return res.status(500).json({ status: 'error', message: data.error });
  return res.json(data);
});

/**
 * 7. POST /api/ai-solve-test
 * Uses Gemini or OpenAI API with multi-key auto-failover to solve questions
 */
app.post('/api/ai-solve-test', async (req, res) => {
  let { apiKey, backupApiKey, apiKeys = [], provider = 'gemini', questions = [] } = req.body;
  
  const allKeys = [
    ...(Array.isArray(apiKeys) ? apiKeys : []),
    apiKey,
    backupApiKey
  ].map(k => (k || '').trim()).filter(Boolean);

  const keysToTry = [...new Set(allKeys)];

  if (keysToTry.length === 0) {
    return res.status(400).json({ status: 'error', message: 'Vui lòng nhập ít nhất 1 API Key (Gemini hoặc OpenAI)' });
  }
  if (!questions || questions.length === 0) {
    return res.status(400).json({ status: 'error', message: 'Danh sách câu hỏi trống' });
  }

  const promptText = `Bạn là chuyên gia giải đề trắc nghiệm đại học. Hãy phân tích các câu hỏi trắc nghiệm sau và chọn đáp án chính xác nhất 100% cho từng câu hỏi.

Danh sách câu hỏi:
${JSON.stringify(questions, null, 2)}

YÊU CẦU QUAN TRỌNG VỀ ĐÁP ÁN:
1. Đọc kỹ số lượng đáp án đúng cần chọn cho mỗi câu (xem trường "number_answer_correct", "question_type", hoặc chỉ dẫn trong nội dung câu hỏi ví dụ "chọn 2 đáp án", "chọn 3 đáp án").
2. Trả về ĐÚNG 1 JSON object duy nhất ánh xạ từ ID của câu hỏi sang đáp án đúng:
   - Nếu câu hỏi chỉ có 1 đáp án đúng: Giá trị là 1 ID đáp án, ví dụ: "101": "2" hoặc "101": "A"
   - Nếu câu hỏi có 2 hoặc nhiều đáp án đúng: Giá trị là 1 MẢNG các ID đáp án đúng, ví dụ: "102": ["1", "3"] hoặc "102": ["B", "C"]
3. KHÔNG thêm giải thích, KHÔNG viết bất kỳ chữ nào ngoài chuỗi JSON hợp lệ.`;

  let lastError = null;

  for (let i = 0; i < keysToTry.length; i++) {
    const currentKey = keysToTry[i];
    try {
      if (provider === 'openai') {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentKey}`
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: promptText }],
            temperature: 0.1
          })
        });
        const data = await resp.json();
        if (!resp.ok || data.error) {
          throw new Error(data.error?.message || `HTTP ${resp.status} từ OpenAI`);
        }
        const rawAns = data.choices?.[0]?.message?.content || '';
        const cleanJson = rawAns.replace(/```json/gi, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanJson);
        return res.json({ status: 'success', answers: parsed, usedKeyIndex: i });
      } else {
        // Gemini API with multi-model fallback: gemini-2.0-flash -> gemini-2.5-flash -> gemini-1.5-flash-latest -> gemini-1.5-flash -> gemini-pro
        const geminiModels = [
          'gemini-2.0-flash',
          'gemini-2.5-flash',
          'gemini-1.5-flash-latest',
          'gemini-1.5-flash',
          'gemini-pro'
        ];

        let parsed = null;
        let lastModelErr = null;

        for (const model of geminiModels) {
          try {
            const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: promptText }] }],
                generationConfig: {
                  responseMimeType: 'application/json'
                }
              })
            });

            const data = await resp.json();
            if (resp.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
              const rawAns = data.candidates[0].content.parts[0].text;
              const cleanJson = rawAns.replace(/```json/gi, '').replace(/```/g, '').trim();
              parsed = JSON.parse(cleanJson);
              break;
            } else {
              lastModelErr = data.error?.message || `HTTP ${resp.status}`;
            }
          } catch (mErr) {
            lastModelErr = mErr.message;
          }
        }

        if (parsed) {
          return res.json({ status: 'success', answers: parsed, usedKeyIndex: i });
        } else {
          throw new Error(lastModelErr || 'Không thể lấy phản hồi từ các mô hình Gemini');
        }
      }
    } catch (err) {
      console.warn(`[AI Solve] Key #${i + 1} gặp lỗi (${err.message}). Đang tự động chuyển key tiếp theo...`);
      lastError = err;
    }
  }

  function formatAiErrorMessage(errMsg, keyCount = 1) {
    if (!errMsg) return 'Không thể kết nối với dịch vụ AI. Vui lòng kiểm tra lại kết nối mạng.';
    if (/quota|resource_exhausted|rate.?limit|429|exceeded/i.test(errMsg)) {
      return `API Key đã hết hạn mức sử dụng (Hết Quota / Rate Limit). ${keyCount === 1 ? 'Vui lòng dán thêm API Key 2 dự phòng hoặc tạo key mới tại Google AI Studio.' : 'Tất cả API Key dự phòng đều đã hết hạn mức.'}`;
    }
    if (/api.?key.?not.?valid|invalid.?argument|api_key_invalid|403|unauthorized|invalid api key/i.test(errMsg)) {
      return 'API Key không chính xác hoặc đã bị vô hiệu hóa. Vui lòng kiểm tra lại API Key đã nhập.';
    }
    if (/not.?found|model/i.test(errMsg)) {
      return 'Mô hình AI đang bận hoặc gián đoạn. Vui lòng thử lại sau vài giây.';
    }
    return errMsg.length > 130 ? errMsg.substring(0, 130) + '...' : errMsg;
  }

  return res.status(400).json({
    status: 'error',
    message: formatAiErrorMessage(lastError?.message || '', keysToTry.length)
  });
});

// Routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[LMS ICTU TOOL] Server running at http://localhost:${PORT}`);
});
