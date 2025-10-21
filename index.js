const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();

// ------------------- Middlewares -------------------
app.use(express.json());
app.use(cors());
app.use(express.static('frontend'));

// ------------------- Banco de Dados -------------------
const db = new sqlite3.Database('./prontuarios.db', (err) => {
  if (err) console.error('❌ Erro ao abrir SQLite:', err.message);
  else console.log('🗄️  Banco SQLite conectado com sucesso.');
});

db.run(`
  CREATE TABLE IF NOT EXISTS prontuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cpf TEXT NOT NULL,
    data_consulta TEXT NOT NULL,
    diagnostico TEXT NOT NULL
  )
`);

// ------------------- IA com DeepSeek -------------------
async function askOllama(prompt) {
  try {
    const resp = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // 👇 modelo DeepSeek local no Ollama
        model: 'deepseek-v3.1:671b-cloud',
        prompt,
        stream: false,
        options: { temperature: 0.7 }
      })
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data.response?.trim() || 'Não foi possível gerar uma resposta.';
  } catch (err) {
    console.warn('⚠️ DeepSeek/Ollama não está ativo. Usando fallback.');
    return 'IA não disponível (DeepSeek offline).';
  }
}

// ------------------- Rota de IA -------------------
app.post('/ai-diagnostico', async (req, res) => {
  const { sintomas = '' } = req.body;
  if (!sintomas.trim()) return res.status(400).json({ error: 'Informe os sintomas para análise.' });

  const prompt = `
Você é um assistente clínico especialista em triagem médica.  
Analise os sintomas e gere hipóteses diagnósticas e orientações.  
Não dê diagnósticos definitivos. Responda **apenas em JSON válido**, no formato:

{
  "hipoteses": ["hipótese 1", "hipótese 2", "..."],
  "gravidade": "baixa|moderada|alta",
  "sinais_alarme": ["sinal 1", "sinal 2"],
  "justificativa": "resumo clínico curto",
  "recomendacao": "orientação prática"
}

SINTOMAS:
${sintomas}
  `.trim();

  const resposta = await askOllama(prompt);

  let sugestao;
  try {
    sugestao = JSON.parse(resposta);
  } catch {
    sugestao = { texto: resposta };
  }

  res.json({ sugestao });
});

// ------------------- Rotas CRUD -------------------
app.post('/prontuario', (req, res) => {
  const { nome, cpf, data_consulta, diagnostico } = req.body;

  if (!nome || !cpf || !data_consulta || !diagnostico)
    return res.status(400).send('Campos obrigatórios: nome, cpf, data_consulta, diagnostico');

  const sql = `INSERT INTO prontuarios (nome, cpf, data_consulta, diagnostico) VALUES (?,?,?,?)`;
  db.run(sql, [nome, cpf, data_consulta, diagnostico], function (err) {
    if (err) return res.status(500).send(err.message);
    res.status(201).json({ message: 'Prontuário salvo!', id: this.lastID });
  });
});

app.get('/prontuarios', (req, res) => {
  db.all(`SELECT * FROM prontuarios ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).send(err.message);
    res.json(rows);
  });
});

// ------------------- Healthcheck -------------------
app.get('/health', (_req, res) => res.json({ ok: true }));

// ------------------- 404 -------------------
app.use((req, res, next) => {
  if (
    req.path.startsWith('/api') ||
    req.path.startsWith('/prontuario') ||
    req.path.startsWith('/prontuarios') ||
    req.path.startsWith('/ai-')
  ) {
    return res.status(404).send(`Rota não encontrada: ${req.method} ${req.path}`);
  }
  next();
});

// ------------------- Start -------------------
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 API MedVibe com DeepSeek rodando em http://localhost:${PORT}`);
});
