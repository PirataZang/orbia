# Changelog

Todas as mudanças notáveis deste projeto ficam neste arquivo.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e o projeto usa [Versionamento Semântico](https://semver.org/lang/pt-BR/).

<!--
INSTRUÇÕES PARA IA (Claude, Copilot, Cursor, ChatGPT…) — leia antes de editar.

Este arquivo é lido pelo DevScope (módulo Releases) na hora de lançar:
  - a seção "## [X.Y.Z] - AAAA-MM-DD" da versão vira a MENSAGEM DA TAG e as
    notas da Release no GitHub — escreva para quem vai ler a página da release;
  - se existe seção para a próxima patch, minor ou major, essa é a versão que
    o DevScope sugere. Então a versão escolhida aqui é a que vai ser lançada.

Como escrever:
  1. Levante o que mudou desde a última release, sem inventar nada:
       git log $(git describe --tags --abbrev=0)..HEAD --oneline
     e o diff quando a mensagem do commit não disser o efeito.
  2. Novidades entram em "## [Unreleased]". Na hora de lançar, renomeie para
     "## [X.Y.Z] - AAAA-MM-DD" e deixe um "## [Unreleased]" vazio acima dela.
  3. Agrupe em ### Added, ### Changed, ### Deprecated, ### Removed, ### Fixed e
     ### Security — nesta ordem, só os que tiverem item.
  4. Um item por mudança que o USUÁRIO percebe, não um por commit. Comece pelo
     efeito ("Login lembra o último e-mail"), não pela implementação
     ("refatora AuthService"). Nome da funcionalidade em negrito.
  5. Escolha a versão pelo maior impacto: algo removido ou incompatível →
     major; funcionalidade nova → minor; só correção ou ajuste pequeno → patch.
  6. Escreva no idioma deste arquivo. Não apague nem reescreva versões já
     lançadas.
-->

## [Unreleased]

### Added

- **Raciocínio na conversa:** com o Claude e com os modelos do Ollama que pensam, o raciocínio aparece recolhido acima da resposta. Ele fica salvo junto com a conversa, mesmo quando o modelo não chega a escrever a resposta.
- **Pensar antes de responder no Ollama:** um interruptor nas configurações do modelo liga ou desliga o `think`. No gpt-oss dá para escolher o nível (baixo, médio ou alto).
- **Opções avançadas do Ollama:** tamanho máximo da resposta, tempo que o modelo fica na memória (`keep_alive`), semente, top-k, top-p, min-p, penalidade de repetição e resposta em JSON. Valores fora do intervalo são recusados antes de chegar ao Ollama.
- **Imagem em tela cheia:** clicar numa imagem da conversa abre ela ocupando a tela. Outro clique mostra o tamanho real, com rolagem, e as setas ← → passam para as outras imagens da mensagem. Funciona também nas miniaturas anexadas antes de enviar.

### Fixed

- **Uso do plano do Claude:** depois do horário de reset, o rodapé deixa de mostrar "0m" para zerar.
- **Arquivos da release:** a release só é publicada quando o AppImage e o `.exe` saem os dois, e os nomes trazem a versão (`Orbia_1.0.0_amd64.AppImage`, `Orbia_1.0.0_x64.exe`). Na 1.0.0 o AppImage saiu com o nome `Orbia_0.1.0_amd64.AppImage`.

## [1.0.0] - 2026-11-25

Primeira versão.

### Added

- **Conversa com as IAs instaladas:** o Orbia acha o Ollama (um item por modelo baixado), o Claude Code, o Gemini CLI e o Codex e abre a conversa numa tela de chat. Se o Ollama estiver instalado mas parado, ele inicia o `ollama serve`. Os CLIs instalados pelo npm, nvm ou bun aparecem mesmo com o app aberto pelo menu.
- **Respostas formatadas:** Markdown, blocos de código com cores por linguagem e botão de copiar.
- **Imagens:** anexe pelo clipe, arrastando para a janela ou colando com Ctrl+V, nas IAs que aceitam imagem.
- **Quatro temas:** Roxo (padrão), Azul, Branco e Preto.
- **Configurações por IA:** a engrenagem abre as configurações da IA da conversa. No Claude: modelo e esforço padrão, instrução extra, skills, plugins, MCPs e as regras do `~/.claude/CLAUDE.md`, com cópia `.bak` antes de salvar. No Ollama: instrução de sistema, temperatura e tamanho do contexto. No Codex: esforço padrão.
- **Painel de comandos:** o botão ⌘ ao lado do clipe troca o modelo e o esforço (de low a max no Claude) da conversa e roda comandos como `/compact` e `/context` com um clique.
- **Menu `/`:** digitar `/` numa conversa com o Claude lista as suas skills, com a descrição de cada uma.
- **Uso do plano do Claude:** o rodapé da barra lateral mostra quanto da sessão e da semana já foi usado e quanto falta para zerar.
- **Histórico:** cada conversa fica salva num arquivo na pasta de dados do app, com o ícone da IA ao lado do título. Apagar pede confirmação.
- **Linux e Windows:** AppImage para Linux e `.exe` para Windows, sem instalador.
