# pi-feishu

一个独立的 [Pi](https://github.com/earendil-works/pi-mono) 飞书扩展。它通过飞书官方 Node SDK 的 WebSocket 长连接，把飞书私聊文本转发到当前 Pi 会话，并以持续更新的交互卡片展示 Pi 的回复和执行状态。

## 设计边界

当前版本只做一条可靠的最小链路：

- 仅处理飞书私聊（`p2p`）文本消息
- 首次启动生成一次性绑定码，只允许一个 Owner
- 所有消息进入当前 Pi 会话，不创建额外 Agent 或会话
- Assistant 文本通过 Pi 的 `message_update` 增量渲染到同一张飞书卡片
- 工具执行时仅显示安全的状态摘要，不展示参数、命令、文件内容或工具输出
- SDK 以 500ms / 120 字符节流卡片更新；完成、失败、中止都会收尾卡片
- 缺少更新权限或飞书卡片更新失败时，自动退化为原私聊的一次性文本回复
- 串行处理消息，避免多条飞书消息同时驱动 Pi
- 按飞书 `message_id` 去重
- `/feishu stop`、`/feishu logout` 和 Pi 会话关闭时释放长连接
- 凭据优先从环境变量读取，也可保存到本地凭据文件

当前不支持群聊、图片、文件、卡片、语音、多用户、多会话、进程级沙箱或远程命令权限管理。这里的安全边界是“私聊 + 单 Owner”，Pi 本身仍拥有当前本地进程的权限。

## 环境要求

- Node.js 22.19 或更高版本
- Pi 0.83.0 或兼容版本
- 一个启用了机器人能力的飞书企业自建应用

## 飞书后台配置

在[飞书开放平台](https://open.feishu.cn/app)创建企业自建应用，然后完成以下配置：

1. 在“添加应用能力”中启用机器人。
2. 在“权限管理”中申请：
   - `im:message.p2p_msg:readonly`：接收私聊消息
   - `im:message:send_as_bot`：以机器人身份回复
   - `im:message:update`：持续更新机器人发出的交互卡片
3. 在“事件与回调”中选择“使用长连接接收事件”。
4. 添加事件 `im.message.receive_v1`。
5. 创建并发布一个应用版本，使权限和事件订阅在企业内生效。

这个扩展不需要公网回调地址，也不需要加密密钥或 Verification Token。若未授予 `im:message:update`，扩展仍可工作，但会降级为最终文本一次性回复。

## 安装

在项目目录安装依赖：

```powershell
cd D:\ai_study\pi-feishu
npm install --ignore-scripts
```

开发时可以仅为本次启动加载：

```powershell
pi -e D:\ai_study\pi-feishu
```

也可以把本地包注册到 Pi：

```powershell
pi install D:\ai_study\pi-feishu
pi
```

发布版本可直接从 npm 安装：

```powershell
pi install npm:@hwj123weijian/pi-feishu
pi
```

## 配置与首次绑定

推荐用环境变量提供敏感凭据：

```powershell
$env:FEISHU_APP_ID = "cli_xxxxxxxxxxxxx"
$env:FEISHU_APP_SECRET = "xxxxxxxxxxxxxxxx"
pi -e D:\ai_study\pi-feishu
```

进入 Pi 后依次执行：

```text
/feishu setup
/feishu start
```

`start` 会在本地 Pi 中显示六位一次性绑定码。使用计划作为 Owner 的飞书账号私聊机器人：

```text
/bind 123456
```

绑定成功后，直接私聊机器人即可驱动当前 Pi 会话。处理过程中会先显示“正在思考”，随后持续更新正文；Pi 调用工具时卡片会显示“正在执行工具”，最终状态会变为“已完成”。

也支持手动参数：

```text
/feishu setup cli_xxxxxxxxxxxxx xxxxxxxxxxxxxxxx
```

这种方式可能让 App Secret 出现在终端历史中，因此环境变量更合适。验证成功后，凭据默认保存到：

```text
~/.pi/agent/feishu/credentials.json
```

文件通过临时文件原子替换写入；在支持 POSIX 权限的平台上会限制为 `0600`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/feishu` | 显示帮助和当前状态 |
| `/feishu setup [appId appSecret]` | 验证并保存飞书应用凭据 |
| `/feishu start` | 建立 WebSocket 长连接并显示绑定码 |
| `/feishu stop` | 停止长连接，保留凭据与 Owner |
| `/feishu status` | 查看配置、连接、Owner 和队列状态 |
| `/feishu logout` | 停止连接并清除本地凭据和 Owner |

环境变量优先于凭据文件。如果环境变量中的 App ID 与已保存的 App ID 不同，旧 Owner 绑定不会被继承。

## 常见问题

### `setup` 或 `start` 连接失败

检查 App ID 和 App Secret 是否来自同一个应用，并确认应用版本已经发布。`setup` 会实际建立一次临时 WebSocket 连接来验证凭据，而不只是检查字符串格式。

### 机器人收不到私聊消息

确认已启用机器人能力、订阅 `im.message.receive_v1`、接收方式为长连接，并已发布包含这些配置的应用版本。

### 能收到消息但不能回复

确认已申请并发布 `im:message:send_as_bot` 权限。

### 只能收到最终文本，没有流式卡片

确认已申请并发布 `im:message:update`。卡片初始化或更新失败时，扩展会自动改为最终文本回复，避免用户没有任何反馈。

### Bot 提示“未授权”

该 Bot 已绑定其他 Owner。若要重新绑定，先在本地 Pi 执行 `/feishu logout`，再重新 `setup`、`start` 和 `/bind`。

### 重复消息

飞书事件可能重投。扩展在当前进程内缓存最近 1000 个 `message_id`，重复事件不会再次驱动 Pi。重启 Pi 后缓存会清空。

## 开发

```powershell
npm run check
npm test
npm run build
```

测试使用 Fake Gateway 和 Fake Agent，不需要真实飞书凭据，覆盖凭据处理、Owner 绑定、私聊过滤、串行队列、去重、Pi 增量文本、工具状态、流式卡片收尾、降级、错误脱敏和清理行为。

## 许可证

MIT
