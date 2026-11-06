本项目在Toonflow的基础上，引入了Hypit，实现“爆款视频复刻”模块。

本项目仅供学习参考。

## 环境准备

- Bun：项目使用 `1.4.3`。
- Node.js：Hypit 要求 `>=22.15.0`，建议使用其 `.node-version` 中的 `24.14.1`。
- pnpm：Hypit 使用 `10.33.0`。

## 首次安装与启动

```sh
git clone https://github.com/lazer6/Toonflow-app.git
cd Toonflow-app

# 安装 Toonflow 依赖
bun install --frozen-lockfile

# 安装爆款视频复刻模块使用的 Hypit 依赖
cd hypit
pnpm install --frozen-lockfile
cd ..

# 构建内置节点、工具和文件扩展
bun run build:nodes
bun run build:tools
bun run build:ext

# 启动前端和后端开发服务
bun run dev
```

启动后，在浏览器中访问终端显示的前端地址，默认是 <http://localhost:5173>。后端默认监听 `3000` 端口。

完成首次安装和构建后，日常启动只需在项目根目录执行：

```sh
bun run dev
```

修改内置节点、工具或文件扩展后，需要重新执行对应的构建命令。

## 本地数据与配置

`data/` 是本地运行数据目录，不随 Git 仓库分发。服务启动时会创建基础配置，并从源码或构建产物初始化内置供应商、技能和插件；工作区及爆款复刻项目目录会在访问相应功能或创建项目时生成。

首次使用需要在界面中配置自己的模型服务、API 密钥和模型 ID，并选择或新建工作目录。其他电脑上的已有画布、素材、会话和项目不会通过启动命令恢复，需要单独迁移。

原版项目说明见 [prime-README.md](./prime-README.md)。
