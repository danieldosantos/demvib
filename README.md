# demvib

## Pré-requisitos
- [Node.js](https://nodejs.org/) 18 ou superior
- npm (já vem junto com o Node.js)

## Instalação das dependências
```bash
npm install
```

## Variáveis de ambiente opcionais
A API utiliza um modelo compatível com a API do Ollama para as sugestões clínicas. Ajuste conforme necessário antes de iniciar o servidor:

```bash
# Endereço do servidor Ollama (padrão: http://127.0.0.1:11434)
export OLLAMA_HOST=http://127.0.0.1:11434

# Nome do modelo a ser utilizado (padrão: deepseek-r1:8b)
export OLLAMA_MODEL=deepseek-r1:8b

# Chave para provedores compatíveis (vazio por padrão)
export OLLAMA_API_KEY=seu_token

# Temperatura usada no modelo (padrão: 0)
export OLLAMA_TEMPERATURE=0.2
```

## Execução em modo desenvolvimento
Inicia a API com recarregamento automático (requer `nodemon`, já listado em `devDependencies`).
```bash
npm run dev
```

## Execução em modo produção
Inicia a API com Node.js padrão.
```bash
npm start
```

Após subir a API, a interface web está disponível em [`http://localhost:3000`](http://localhost:3000). O Express já expõe a pasta `frontend/`, portanto basta acessar o endereço para utilizar a aplicação.

## Banco de dados
O arquivo `prontuarios.db` é criado automaticamente na primeira execução. Não é necessário nenhum passo adicional para inicializar o banco SQLite.
