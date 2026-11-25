# Orbia: desenho da primeira versão

Data: 2026-11-25

## Para que serve

Quem tem IA instalada no computador (Ollama, Claude Code, Gemini CLI, Codex) hoje conversa com ela pelo terminal: texto cru, `**` e `#` aparecendo na tela, sem imagens. O Orbia é um app de desktop que acha essas ferramentas sozinho e deixa a pessoa conversar com elas numa tela de chat, com o texto formatado e imagens.

O Orbia não conecta em nada por conta própria e não pede chave de API nem conta. Ele roda as mesmas ferramentas que a pessoa rodaria no terminal; só a tela muda.

Público: qualquer pessoa que já tem uma IA local ou um CLI de IA instalado, em Linux ou Windows.

## Objetivos

- Abrir o app e ver, sem configurar nada, a lista das IAs encontradas no PC.
- Escolher uma e conversar como num chat (mensagens em balões, resposta aparecendo enquanto é gerada).
- Respostas em Markdown renderizado: títulos, negrito, listas, tabelas, blocos de código com botão de copiar.
- Anexar imagens (botão, arrastar ou colar) quando a ferramenta escolhida aceita imagens.
- Quatro temas: Roxo (padrão), Azul, Branco e Preto.
- Visual premium e minimalista.
- Entrega simples: um `.AppImage` para Linux e um `.exe` para Windows.

## Fora da primeira versão

- Chaves de API, contas, login, qualquer conexão com serviço de fora.
- Baixar modelos de dentro do app (`ollama pull`). Se não houver modelo, o app explica o comando.
- Mostrar ou aprovar ações de ferramentas (Claude Code e Codex editando arquivos, rodando comandos).
- Voz, plugins, atualização automática, macOS, assinatura de código.

## O que faria o Orbia falhar mesmo funcionando

- Enviar qualquer coisa para algum lugar que a pessoa não escolheu.
- Ficar pesado a ponto de atrapalhar o modelo local, que já usa muita RAM.
- Parecer um template genérico de chat de IA.
- Alterar arquivos ou configurações das ferramentas da pessoa.
- Precisar de terminal para instalar ou abrir.

## Abordagens consideradas

1. **Tauri 2 (escolhida).** Backend em Rust roda as ferramentas; a tela é HTML/CSS no navegador embutido do sistema. `.exe` de uns 10 MB (usa o WebView2 que já vem no Windows 10/11), AppImage de uns 80 MB. Rust é a linguagem que o dono do projeto já usa. Ponto fraco: o WebKitGTK do Linux às vezes desenha um detalhe de CSS diferente do Windows.
2. **Electron.** Tela idêntica nos dois sistemas, mas arquivos acima de 100 MB e bem mais memória. Recusado pelo dono do projeto.
3. **Terminal embutido (xterm.js + PTY)** mostrando as ferramentas como elas são. Descartado: fica igual ao terminal e perde o motivo do app.
4. **Interface nativa em Rust (egui/iced).** Descartado: visual premium e Markdown bem renderizado dão muito mais trabalho.

## Decisões do dono do projeto

- Nome: Orbia.
- App de desktop com janela própria, não TUI.
- Usa só o que já está instalado; nenhuma conexão, nenhuma chave.
- Ferramentas da primeira versão: Ollama, Claude Code, Gemini CLI, Codex.
- Temas Roxo, Azul, Branco e Preto, padrão Roxo. Estilo premium e minimalista.
- Saídas: `.AppImage` e `.exe`.
- Pasta: `~/Documentos/projects/orbia`.
- Tauri, sem Electron.

## Como funciona

### Tela

```
┌──────────────┬──────────────────────────────────────────┐
│ ◉ Orbia      │  llama3.2-vision · Ollama            ◐   │
│              │                                          │
│ IAS NO PC    │        ┌───────────────────────────┐     │
│ ● llama3.2   │        │ o que tem nessa imagem?   │     │
│ ○ qwen2.5    │        │ [miniatura]               │     │
│ ○ Claude     │        └───────────────────────────┘     │
│ ○ Codex      │  ┌──────────────────────────────────┐    │
│              │  │ ## Uma praia                     │    │
│ CONVERSAS    │  │ - **areia** clara …              │    │
│ Praia (hoje) │  └──────────────────────────────────┘    │
│ Script bash  │                                          │
│ + Nova       │  ┌──────────────────────────────┐ 📎 ➤  │
│              │  │ Escreva sua mensagem…        │       │
└──────────────┴──────────────────────────────────────────┘
```

- Barra lateral: IAs encontradas (um item por modelo do Ollama, um por CLI) e a lista de conversas.
- Topo: IA da conversa atual e o seletor de tema.
- Durante a resposta, o botão de enviar vira "parar".
- Sem nenhuma IA encontrada: tela explicando como instalar o Ollama e baixar um modelo, com os comandos para copiar.
- Erro de uma ferramenta (não logada, modelo inexistente): o texto que ela devolveu aparece dentro da conversa, em destaque, sem travar o app.

### Varredura

Ao abrir e quando a pessoa clica em "procurar de novo":

| Ferramenta | Como detecta | Itens na lista |
|---|---|---|
| Ollama | binário `ollama` no PATH (no Windows, também `%LOCALAPPDATA%\Programs\Ollama`) e `GET http://127.0.0.1:11434/api/tags` | um por modelo |
| Claude Code | `claude` no PATH | "Claude" |
| Gemini CLI | `gemini` no PATH | "Gemini" |
| Codex | `codex` no PATH | "Codex" |

Se o binário do Ollama existe mas o serviço não responde, o Orbia inicia `ollama serve` em segundo plano e tenta de novo.

### Como cada ferramenta é chamada

Regra geral: o processo é iniciado com lista de argumentos, nunca por um shell. A saída é lida linha a linha e repassada à tela como eventos de streaming. Quando o CLI aceitar, a mensagem vai pela entrada padrão (stdin) em vez de argumento, o que evita o limite de 32 mil caracteres da linha de comando do Windows.

Localizar os binários (escolha minha):
- Linux: o PATH do processo mais as pastas onde esses CLIs costumam ficar (`~/.local/bin`, `~/.npm-global/bin`, `~/.nvm/versions/node/*/bin`, `~/.bun/bin`, `/usr/local/bin`, `/opt/homebrew/bin`). Um AppImage aberto pelo menu não herda o PATH do `.bashrc`, por isso a lista fixa. Ler o PATH de um shell de login (`bash -lc 'echo $PATH'`) também é aceito, porque nenhum texto do usuário passa por ele.
- Windows: CLIs instalados pelo npm são arquivos `.cmd`, que só rodam via `cmd.exe`. O Orbia lê o `.cmd`, acha o script JavaScript que ele chama e roda `node <script>` direto, sem passar a mensagem pelo `cmd.exe`.

- **Ollama:** `POST http://127.0.0.1:11434/api/chat` com `stream: true`, mandando o histórico inteiro da conversa e as imagens em base64. É o serviço local que o próprio Ollama deixa rodando; o `ollama run` de uma resposta só não guarda histórico. Imagens só ficam habilitadas se o modelo tiver `vision` nas capacidades (`POST /api/show`).
- **Claude Code:** `claude -p <mensagem> --output-format stream-json --verbose`, e nas mensagens seguintes `--resume <session_id>` (o id vem na primeira linha do stream). Imagens: o arquivo é copiado para dentro da pasta de trabalho da conversa (fora dela o `-p` não consegue ler) e o caminho relativo vai na mensagem.
- **Gemini CLI:** `gemini -p <mensagem>` com saída em stream JSON se a versão instalada oferecer; senão, texto puro. Continuidade pela retomada de sessão do próprio CLI se existir; senão, o Orbia manda as últimas mensagens junto. Imagens: copiadas para a pasta de trabalho e citadas com `@arquivo` na mensagem, se a versão instalada aceitar; senão, o anexo fica desabilitado para o Gemini.
- **Codex:** `codex exec --json <mensagem>`, e nas seguintes `codex exec resume <id>`. Imagens com `-i <arquivo>`. Sempre com sandbox somente leitura.

Os CLIs rodam numa pasta de trabalho própria e vazia dentro da pasta de dados do app, nunca na pasta pessoal do usuário, para não lerem nem mudarem arquivos dele. Claude Code roda no modo de permissão padrão, que no `-p` recusa ações que pediriam aprovação.

Os nomes exatos das flags devem ser conferidos contra a versão instalada de cada CLI na hora de implementar.

### Conversas

Cada conversa é salva como um arquivo JSON na pasta de dados do app (Tauri `app_data_dir`): IA usada, id de sessão do CLI quando houver, mensagens e caminhos das imagens anexadas (cópias guardadas junto). Some só quando a pessoa apaga.

### Temas e visual

- Cores definidas como variáveis CSS; trocar de tema troca o conjunto. Tema escolhido salvo nas configurações do app.
- Roxo (padrão) e Azul: fundo escuro com o acento na cor do tema. Preto: escuro neutro. Branco: claro.
- Uma fonte sans para a interface e uma mono para código, ambas embutidas no app (sem carregar nada da internet).
- Ícone: uma órbita simples.

### Segurança

- O texto da IA vira HTML pelo renderizador de Markdown e passa por DOMPurify antes de ir para a tela. Sem isso, uma resposta com `<script>` teria acesso às funções do app.
- CSP restrita no Tauri: nada de scripts ou recursos de fora.
- O frontend só pode chamar os comandos que o backend expõe (listar IAs, enviar, parar, conversas, tema). Nenhum comando genérico de "rodar processo".

### Entrega

- AppImage: gerado no GitHub Actions num runner Ubuntu 22.04, para rodar no Ubuntu 22.04 ou mais novo e em distribuições da mesma época (um AppImage só roda com glibc igual ou mais nova que a de onde foi gerado). Nesta máquina, `cargo tauri build --bundles appimage` serve só para teste. Escolha minha.
- `.exe`: GitHub Actions num runner Windows, gerado quando uma tag de versão é publicada, anexado à release. Entregar o executável solto (WebView2 já vem no Windows 10/11).
- Sem assinatura, o Windows mostra o aviso do SmartScreen na primeira abertura. O README explica como passar por ele.

## Escolhas que fiz (podem ser mudadas)

- Interface em português.
- Conversas salvas em disco, não só na memória.
- Frontend em TypeScript sem framework (Vite + `marked` + `DOMPurify`). Sem realce de cores em blocos de código na primeira versão.

## Fica para quem construir

- Estrutura de pastas, nomes de módulos, testes.
- Paleta exata de cada tema e tipografia, dentro de "premium e minimalista".
- Como mostrar o andamento da varredura.
- Desenho do ícone.
