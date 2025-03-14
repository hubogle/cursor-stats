// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as fs from 'fs';
import https from 'https';
import * as jwt from 'jsonwebtoken';
import * as os from 'os';
import * as path from 'path';
import initSqlJs from 'sql.js';
import * as vscode from 'vscode';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	// 创建状态栏项
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
	statusBarItem.command = 'cursor-stats.checkStats';
	statusBarItem.show();

	// 修改更新函数
	const updateStatusBar = async (usage: CursorUsageResponse) => {
		const gpt4Usage = usage['gpt-4'];
		let statusText = `$(symbol-keyword) GPT: ${gpt4Usage.numRequests}/${gpt4Usage.maxRequestUsage}`;
		statusBarItem.text = statusText;
	};

	// 修改 tooltip 更新函数
	const updateTooltip = (usage: CursorUsageResponse, membership: CursorMembershipResponse, email?: string, checkTime?: Date) => {
		const markdown = new vscode.MarkdownString();
		markdown.isTrusted = true;
		markdown.supportHtml = true;
		markdown.supportThemeIcons = true;

		markdown.appendMarkdown(`#### Cursor 使用情况 \n\n`);

		if (email) {
			markdown.appendMarkdown(`**账号:** ${email}\n\n`);
		}

		markdown.appendMarkdown(`**状态:** ${membership.membershipType === 'free_trial' ?
			`试用期（剩余 ${membership.daysRemainingOnTrial} 天）` :
			membership.membershipType}\n\n`);

		if (checkTime) {
			const checkTimeStr = checkTime.toLocaleString('zh-CN', {
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
				hour12: false,
				timeZone: 'Asia/Shanghai'
			});
			markdown.appendMarkdown(`**查询时间:** ${checkTimeStr}\n\n`);
		}

		markdown.appendMarkdown(`**请求用量:** ${usage['gpt-4'].numRequests}/${usage['gpt-4'].maxRequestUsage}\n\n`);

		markdown.appendMarkdown(`**Token Total:** ${usage['gpt-4'].numTokens}\n\n`);

		// 添加底部链接
		markdown.appendMarkdown(`<a href="https://www.cursor.com/settings" title="在浏览器中打开设置"><span style="color:#007ACC;">在浏览器中查看更多详情</span></a>`);

		statusBarItem.tooltip = markdown;
	};

	// 修改命令处理函数
	const tokenCommand = vscode.commands.registerCommand('cursor-stats.checkStats', async () => {
		try {
			const tokenInfo = await getCursorToken();
			if (tokenInfo) {
				const [usage, membership] = await Promise.all([
					getCursorUsage(tokenInfo.userId, tokenInfo.token),
					getCursorMembership(tokenInfo.token)
				]);

				if (usage && membership) {
					updateStatusBar(usage);
					updateTooltip(usage, membership, tokenInfo.email, new Date());
				} else {
					vscode.window.showErrorMessage('获取信息失败');
				}
			} else {
				vscode.window.showErrorMessage('未能获取到 Token');
			}
		} catch (error) {
			vscode.window.showErrorMessage(`操作失败: ${error}`);
		}
	});

	// 修改自动更新逻辑
	const updateInterval = 10 * 60 * 1000; // 10分钟更新一次
	setInterval(async () => {
		const tokenInfo = await getCursorToken();
		if (tokenInfo) {
			const [usage, membership] = await Promise.all([
				getCursorUsage(tokenInfo.userId, tokenInfo.token),
				getCursorMembership(tokenInfo.token)
			]);
			if (usage && membership) {
				updateStatusBar(usage);
				updateTooltip(usage, membership, tokenInfo.email, new Date());
			}
		}
	}, updateInterval);

	// 在插件激活时自动执行 checkStats 命令
	vscode.commands.executeCommand('cursor-stats.checkStats');

	context.subscriptions.push(tokenCommand);
	context.subscriptions.push(statusBarItem);
}

// This method is called when your extension is deactivated
export function deactivate() { }

// 获取 Cursor 数据库路径
function getCursorDBPath(): string {
	const appName = vscode.env.appName;
	const folderName = appName === 'Cursor Nightly' ? 'Cursor Nightly' : 'Cursor';
	return path.join(os.homedir(), 'Library', 'Application Support', folderName, 'User', 'globalStorage', 'state.vscdb');
}

// 获取 Cursor Token
async function getCursorToken(): Promise<{ userId: string, token: string, email?: string } | undefined> {
	try {
		const dbPath = getCursorDBPath();
		if (!fs.existsSync(dbPath)) {
			return undefined;
		}

		const dbBuffer = fs.readFileSync(dbPath);
		const SQL = await initSqlJs();
		const db = new SQL.Database(new Uint8Array(dbBuffer));

		// 查询 token 和 email
		const tokenResult = db.exec("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'");
		const emailResult = db.exec("SELECT value FROM ItemTable WHERE key = 'cursorAuth/cachedEmail'");

		if (!tokenResult.length || !tokenResult[0].values.length) {
			db.close();
			return undefined;
		}

		const token = tokenResult[0].values[0][0] as string;
		const decoded = jwt.decode(token, { complete: true });

		if (!decoded?.payload?.sub) {
			db.close();
			return undefined;
		}

		const userId = decoded.payload.sub.toString().split('|')[1];

		// 提取电子邮件信息
		let email: string | undefined;
		if (emailResult.length && emailResult[0].values.length) {
			email = emailResult[0].values[0][0] as string;
		}

		db.close();
		return { userId, token: token, email };
	} catch (error) {
		console.error('获取 Token 失败:', error);
		return undefined;
	}
}

// 添加获取使用量的函数
async function getCursorUsage(userId: string, token: string): Promise<CursorUsageResponse | undefined> {
	try {
		const sessionToken = `${userId}%3A%3A${token}`;
		const options = {
			hostname: 'www.cursor.com',
			path: `/api/usage?user=${encodeURIComponent(userId)}`,
			method: 'GET',
			headers: {
				'Cookie': `WorkosCursorSessionToken=${sessionToken}`,
				'Referer': 'https://www.cursor.com/settings',
			},
		};

		return new Promise((resolve, reject) => {
			const req = https.request(options, (res) => {
				let data = '';

				res.on('data', (chunk) => {
					data += chunk;
				});

				res.on('end', () => {
					try {
						const response = JSON.parse(data) as CursorUsageResponse;
						resolve(response);
					} catch (error) {
						reject(error);
					}
				});
			});

			req.on('error', (error) => {
				reject(error);
			});

			req.end();
		});
	} catch (error) {
		console.error('获取使用量失败:', error);
		return undefined;
	}
}

// 添加获取会员信息的函数
async function getCursorMembership(token: string): Promise<CursorMembershipResponse | undefined> {
	try {
		const options = {
			hostname: 'api2.cursor.sh',
			path: '/auth/full_stripe_profile',
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Origin': 'vscode-file://vscode-app'
			},
		};

		return new Promise((resolve, reject) => {
			const req = https.request(options, (res) => {
				let data = '';
				res.on('data', (chunk) => data += chunk);
				res.on('end', () => {
					try {
						const response = JSON.parse(data) as CursorMembershipResponse;
						resolve(response);
					} catch (error) {
						reject(error);
					}
				});
			});
			req.on('error', (error) => reject(error));
			req.end();
		});
	} catch (error) {
		console.error('获取会员信息失败:', error);
		return undefined;
	}
}

export interface CursorUsageResponse {
	'gpt-4': {
		numRequests: number;
		numRequestsTotal: number;
		numTokens: number;
		maxRequestUsage: number;
		maxTokenUsage: number | null;
	};
	'gpt-3.5-turbo': {
		numRequests: number;
		numRequestsTotal: number;
		numTokens: number;
		maxRequestUsage: number | null;
		maxTokenUsage: number | null;
	};
	'gpt-4-32k': {
		numRequests: number;
		numRequestsTotal: number;
		numTokens: number;
		maxRequestUsage: number | null;
		maxTokenUsage: number | null;
	};
	startOfMonth: string;
}

interface CursorMembershipResponse {
	membershipType: string;
	daysRemainingOnTrial: number;
}