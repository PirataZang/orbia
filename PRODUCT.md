# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Tauri 2 desktop app: the UI is HTML/CSS in the system webview, WebView2 on Windows, WebKitGTK on Linux.)

## Stack

Tauri 2, backend em Rust, frontend em TypeScript sem framework (Vite + marked + DOMPurify). Fonte: spec `docs/superpowers/specs/2026-11-25-orbia-design.md`.

## Users

Qualquer pessoa que já tem uma IA local ou um CLI de IA instalado (Ollama, Claude Code, Gemini CLI, Codex), em Linux ou Windows, e hoje conversa com ela pelo terminal.

## Product Purpose

Abrir o app e conversar com as IAs que já estão no PC numa tela de chat: Markdown renderizado, imagens anexadas, resposta em streaming. Sucesso é abrir e usar sem configurar nada.

## Positioning

O Orbia não conecta em nada nem pede chave ou conta. Ele roda as mesmas ferramentas que a pessoa rodaria no terminal; só a tela muda.

## Capabilities and Constraints

- Plug and play: acha as IAs sozinho, sobe o `ollama serve` se precisar, nunca pede terminal para instalar ou abrir.
- Não envia nada para lugar que a pessoa não escolheu.
- A configuração das ferramentas só muda pela tela de configurações, por ação da pessoa, com cópia `.bak` dos arquivos de texto (decisão do dono em 2026-11-25; ver `docs/superpowers/specs/2026-11-25-orbia-configuracoes-design.md`).
- Leve: divide a máquina com modelos locais que usam muita RAM.
- Fora da v1: chaves de API, download de modelos, aprovação de ações das ferramentas, voz, plugins, auto-update, macOS.

## Brand Commitments

- Nome Orbia. Ícone: uma órbita simples.
- Temas Roxo (padrão), Azul, Branco e Preto. Visual premium e minimalista; não pode parecer template genérico de chat de IA.
- Interface em português.
- Fontes embutidas no app, nada carregado da internet.
- Direção visual: padrão da categoria executado com cuidado (escolha do dono, 2026-11-25). Régua: Claude desktop, ChatGPT desktop, Raycast AI.

## Product Principles

1. Zero configuração: o que a pessoa já instalou aparece sozinho.
2. Nada sai da máquina sem a pessoa pedir.
3. A ferramenta some; a conversa fica.
