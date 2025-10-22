const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();

// ------------------- Middlewares -------------------
app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static('frontend'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Garante pasta de uploads
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });

// ------------------- Banco de Dados -------------------
const db = new sqlite3.Database('./prontuarios.db', (err) => {
  if (err) console.error('❌ Erro ao abrir SQLite:', err.message);
  else console.log('🗄️  Banco SQLite conectado com sucesso.');
});

// Garante chaves estrangeiras (necessário no SQLite)
db.run('PRAGMA foreign_keys = ON');

// Tabela principal
db.run(`
  CREATE TABLE IF NOT EXISTS prontuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cpf TEXT NOT NULL,
    data_consulta TEXT NOT NULL,
    diagnostico TEXT NOT NULL,
    sintomas TEXT DEFAULT '',
    anamnese TEXT DEFAULT '',
    exames_solicitados TEXT DEFAULT '[]'  -- JSON: ["Hemograma", "RX tórax", ...]
  )
`);

// Adiciona colunas se faltarem (migração simples)
db.serialize(() => {
  db.run(`ALTER TABLE prontuarios ADD COLUMN sintomas TEXT DEFAULT ''`, (e)=>{});
  db.run(`ALTER TABLE prontuarios ADD COLUMN anamnese TEXT DEFAULT ''`, (e)=>{});
  db.run(`ALTER TABLE prontuarios ADD COLUMN exames_solicitados TEXT DEFAULT '[]'`, (e)=>{});
});

// Tabela de exames (meta + arquivo/resultado)
db.run(`
  CREATE TABLE IF NOT EXISTS exames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prontuario_id INTEGER NOT NULL,
    tipo TEXT,                -- p.ex.: "Hemograma", "PCR", "RX tórax"
    observacoes TEXT,         -- livre
    arquivo_path TEXT,        -- se upload de arquivo
    resultado_texto TEXT,     -- se resultado textual
    data_resultado TEXT,      -- ISO YYYY-MM-DD
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(prontuario_id) REFERENCES prontuarios(id) ON DELETE CASCADE
  )
`);

// ------------------- Config IA (local ou cloud) -------------------
const OLLAMA_HOST  = process.env.OLLAMA_HOST  || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-r1:8b';
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';
const OLLAMA_TEMPERATURE = (() => {
  const value = Number(process.env.OLLAMA_TEMPERATURE);
  return Number.isFinite(value) ? value : 0;
})();

// ------------------- Upload (multer) -------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_');
    cb(null, `${ts}__${safe}`);
  }
});
const upload = multer({ storage });

// ------------------- Util: juntar exames do prontuário -------------------
function fetchExamsSummary(prontuario_id) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, tipo, observacoes, arquivo_path, resultado_texto, data_resultado AS data_anexo
       FROM exames WHERE prontuario_id = ? ORDER BY created_at DESC`,
      [prontuario_id],
      (err, rows) => {
        if (err) return reject(err);
        // Constrói um resumo textual pro prompt da IA
        const lines = rows.map(r => {
          const parts = [];
          if (r.tipo) parts.push(`Tipo: ${r.tipo}`);
          if (r.data_anexo) parts.push(`Data de anexo: ${r.data_anexo}`);
          if (r.resultado_texto) parts.push(`Resultado textual: ${r.resultado_texto}`);
          if (r.observacoes) parts.push(`Obs: ${r.observacoes}`);
          if (r.archivo_path || r.arquivo_path) {
            const p = r.archivo_path || r.arquivo_path; // typo-safe
            parts.push(`Arquivo: ${p}`);
            if (!r.resultado_texto) parts.push('Sem laudo textual: interpretar arquivo anexado.');
          }
          return `- ${parts.join(' | ')}`;
        });
        resolve(lines.join('\n'));
      }
    );
  });
}

// ------------------- Função de chamada à IA -------------------
async function askOllama(prompt) {
  const headers = { 'Content-Type': 'application/json' };
  if (OLLAMA_API_KEY) headers['Authorization'] = `Bearer ${OLLAMA_API_KEY}`;

  const resp = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: 'json',             // força resposta JSON
      options: { temperature: OLLAMA_TEMPERATURE }
    })
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Ollama HTTP ${resp.status} - ${txt}`);
  }

  const data = await resp.json();
  return (data.response || '').trim(); // string JSON
}

// ------------------- Rota de IA -------------------
app.post('/ai-diagnostico', async (req, res) => {
  try {
    const {
      sintomas = '',
      anamnese = '',
      prontuario_id = null,   // se vier, busca exames do ID
      exames_resumo = ''      // opcional: permitir enviar resumo direto do front
    } = req.body || {};

    if (!sintomas.trim() && !anamnese.trim())
      return res.status(400).json({ error: 'Informe ao menos sintomas ou anamnese.' });

    // monta bloco de exames: usa (a) resumo enviado OU (b) busca no banco pelo prontuario_id
    let examesBloco = '';
    if (exames_resumo && exames_resumo.trim()) {
      examesBloco = exames_resumo.trim();
    } else if (prontuario_id) {
      try {
        const summary = await fetchExamsSummary(prontuario_id);
        examesBloco = summary || '';
      } catch (e) {
        console.warn('⚠️ Falha ao buscar exames do prontuário:', e.message);
      }
    }

    const prompt = `
Você atua como médico regulador virtual de triagem clínica, seguindo rigorosamente protocolos da OMS e diretrizes do Sistema Único de Saúde (SUS). Responda em português do Brasil.
Não forneça diagnóstico definitivo nem prescrição; formule apenas hipóteses diagnósticas iniciais e condutas orientativas.
Utilize exclusivamente os dados fornecidos; não invente informações. Quando houver lacunas, declare a incerteza explicitamente.
Aplique raciocínio clínico estruturado, terminologia técnica e estratificação de risco baseada em evidências internacionais e nacionais vigentes.

Regras de gravidade (selecione apenas UMA):
- "alta": falta de ar moderada/grave, SpO2 < 95%, dor/pressão torácica importante, confusão/sonolência, síncope, rigidez de nuca, hemoptise, sinais de sepse, desidratação grave, piora rápida.
- "moderada": febre ≥ 38,5 °C por ≥ 3 dias, dor torácica leve-moderada, vômitos persistentes, diarreia moderada, dor intensa localizada, piora sem sinais de alarme.
- "baixa": sintomas leves autolimitados e sem alarme.
- "indefinida": dados insuficientes para classificação.

Sinais de alarme possíveis:
["falta de ar","SpO2<95%","dor/pressão no peito","confusão/sonolência","rigidez de nuca","hemoptise","desidratação grave","oligúria","cianose","sinais de sepse","piora rápida","síncope"]

Formato OBRIGATÓRIO (JSON válido, sem texto fora do JSON):
{
  "hipoteses": ["hipótese 1", "hipótese 2", "hipótese 3"],
  "gravidade": "baixa|moderada|alta|indefinida",
  "sinais_alarme": ["zero ou mais itens da lista acima"],
  "justificativa": "até 50 palavras, objetiva",
  "recomendacao": "até 160 caracteres",
  "exames_sugeridos": ["opcional: até 3"],
  "confianca": 0.0
}

DADOS DO PACIENTE
SINTOMAS:
${sintomas || '(não informado)'}

ANAMNESE:
${anamnese || '(não informada)'}

RESULTADOS/RESUMO DE EXAMES:
${examesBloco || '(sem exames disponíveis)'}
    `.trim();

    const raw = await askOllama(prompt);

    let sugestao;
    try {
      sugestao = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}$/);
      sugestao = m ? JSON.parse(m[0]) : { texto: raw || 'sem resposta' };
    }

    return res.json({ sugestao, model: OLLAMA_MODEL, host: OLLAMA_HOST });
  } catch (e) {
    console.error('❌ Erro IA:', e.message);
    return res.status(502).json({ error: 'IA indisponível', detail: e.message, model: OLLAMA_MODEL, host: OLLAMA_HOST });
  }
});

// ------------------- Rotas CRUD Prontuário -------------------
app.post('/prontuario', (req, res) => {
  const { nome, cpf, data_consulta, diagnostico, sintomas = '', anamnese = '', exames_solicitados = [] } = req.body || {};

  if (!nome || !cpf || !data_consulta || !diagnostico)
    return res.status(400).send('Campos obrigatórios: nome, cpf, data_consulta, diagnostico');

  const examesStr = Array.isArray(exames_solicitados) ? JSON.stringify(exames_solicitados) : '[]';

  const sql = `INSERT INTO prontuarios (nome, cpf, data_consulta, diagnostico, sintomas, anamnese, exames_solicitados)
               VALUES (?,?,?,?,?,?,?)`;
  db.run(sql, [nome, cpf, data_consulta, diagnostico, sintomas, anamnese, examesStr], function (err) {
    if (err) return res.status(500).send(err.message);
    res.status(201).json({ message: 'Prontuário salvo!', id: this.lastID });
  });
});

app.put('/prontuario/:id', (req, res) => {
  const { id } = req.params;
  const { nome, cpf, data_consulta, diagnostico, sintomas = '', anamnese = '', exames_solicitados = [] } = req.body || {};

  if (!id) return res.status(400).send('ID obrigatório para atualização');
  if (!nome || !cpf || !data_consulta || !diagnostico)
    return res.status(400).send('Campos obrigatórios: nome, cpf, data_consulta, diagnostico');

  const examesStr = Array.isArray(exames_solicitados) ? JSON.stringify(exames_solicitados) : '[]';

  const sql = `UPDATE prontuarios
               SET nome = ?, cpf = ?, data_consulta = ?, diagnostico = ?, sintomas = ?, anamnese = ?, exames_solicitados = ?
               WHERE id = ?`;

  db.run(sql, [nome, cpf, data_consulta, diagnostico, sintomas, anamnese, examesStr, id], function (err) {
    if (err) return res.status(500).send(err.message);
    if (this.changes === 0) return res.status(404).send('Prontuário não encontrado');
    res.json({ message: 'Prontuário atualizado!', id: Number(id) });
  });
});

app.delete('/prontuario/:id', (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).send('ID obrigatório para exclusão');

  db.run(`DELETE FROM prontuarios WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).send(err.message);
    if (this.changes === 0) return res.status(404).send('Prontuário não encontrado');
    res.json({ message: 'Prontuário excluído!', id: Number(id) });
  });
});

app.get('/prontuarios', (_req, res) => {
  db.all(`SELECT * FROM prontuarios ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).send(err.message);
    res.json(rows.map(r => ({
      ...r,
      exames_solicitados: (() => { try { return JSON.parse(r.exames_solicitados || '[]'); } catch { return []; } })()
    })));
  });
});

// ------------------- Rotas Exames -------------------

// Upload de arquivo de exame
app.post('/exames/upload', upload.single('arquivo'), (req, res) => {
  const { prontuario_id, tipo = '', observacoes = '', data_anexo = '', data_resultado = '' } = req.body || {};
  if (!prontuario_id) return res.status(400).json({ error: 'Informe prontuario_id' });
  if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado (campo "arquivo")' });

  const arquivo_path = `/uploads/${req.file.filename}`;
  const sql = `INSERT INTO exames (prontuario_id, tipo, observacoes, arquivo_path, resultado_texto, data_resultado)
               VALUES (?,?,?,?,?,?)`;
  const dataFinal = data_anexo || data_resultado || '';
  db.run(sql, [prontuario_id, tipo, observacoes, arquivo_path, null, dataFinal || null], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ message: 'Exame anexado com sucesso', id: this.lastID, arquivo_path, data_anexo: dataFinal || null });
  });
});

// Resultado textual (sem arquivo)
app.post('/exames/texto', (req, res) => {
  const { prontuario_id, tipo = '', observacoes = '', resultado_texto = '', data_anexo = '', data_resultado = '' } = req.body || {};
  if (!prontuario_id) return res.status(400).json({ error: 'Informe prontuario_id' });
  if (!resultado_texto.trim()) return res.status(400).json({ error: 'resultado_texto vazio' });

  const sql = `INSERT INTO exames (prontuario_id, tipo, observacoes, arquivo_path, resultado_texto, data_resultado)
               VALUES (?,?,?,?,?,?)`;
  const dataFinal = data_anexo || data_resultado || '';
  db.run(sql, [prontuario_id, tipo, observacoes, null, resultado_texto, dataFinal || null], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ message: 'Resultado registrado', id: this.lastID, data_anexo: dataFinal || null });
  });
});

// Listar exames por prontuário
app.get('/exames', (req, res) => {
  const { prontuario_id } = req.query || {};
  if (!prontuario_id) return res.status(400).json({ error: 'Informe prontuario_id' });

  db.all(
    `SELECT id, tipo, observacoes, arquivo_path, resultado_texto, data_resultado, created_at
     FROM exames WHERE prontuario_id = ? ORDER BY created_at DESC`,
    [prontuario_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const mapped = rows.map(r => ({
        ...r,
        data_anexo: r.data_resultado
      }));
      res.json(mapped);
    }
  );
});

// ------------------- Healthcheck -------------------
app.get('/health', (_req, res) => res.json({ ok: true }));

// ------------------- 404 -------------------
app.use((req, res, next) => {
  if (
    req.path.startsWith('/api') ||
    req.path.startsWith('/prontuario') ||
    req.path.startsWith('/prontuarios') ||
    req.path.startsWith('/ai-') ||
    req.path.startsWith('/exames')
  ) {
    return res.status(404).send(`Rota não encontrada: ${req.method} ${req.path}`);
  }
  next();
});

// ------------------- Start -------------------
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 API MedVibe rodando em http://localhost:${PORT}`);
  console.log(`🤖 IA: ${OLLAMA_MODEL} @ ${OLLAMA_HOST} ${OLLAMA_API_KEY ? '(cloud)' : '(local)'}`);
});
