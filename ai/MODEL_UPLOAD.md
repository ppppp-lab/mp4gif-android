# 魔搭上传步骤

模型已整理在 `modelscope-upload/mp4gif-ai/`，目录里有 `mp4gif-ai.gguf` 和 `README.md`。

1. 登录魔搭：

```powershell
cd D:\codex\CodeX-Workspace\05_Resources\docs\ai-function-call
.\.venv\Scripts\modelscope.exe login
```

2. 创建公开模型仓库（仓库名可换成你自己的，但 App 直链要一致）：

```powershell
.\.venv\Scripts\modelscope.exe create 你的用户名/mp4gif-ai --repo-type model --visibility public --chinese-name "MP4GIF AI 指令模型" --description "MP4GIF 表情包工坊中文指令转函数调用模型" --exist-ok
```

3. 上传：

```powershell
.\.venv\Scripts\modelscope.exe upload 你的用户名/mp4gif-ai .\modelscope-upload\mp4gif-ai --repo-type model --commit-message "Upload mp4gif-ai 0.1.0"
```

4. 上传完成后，App 内 `AiConfig.kt` 使用以下直链：

```text
https://modelscope.cn/models/你的用户名/mp4gif-ai/resolve/master/mp4gif-ai.gguf
```

SHA-256：

```text
23FE15B6207B71EEF275885D33D2B76A8CC64D55EC2222F50008F7C1694118E4
```
