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
	const updateTooltip = (usage: CursorUsageResponse, membership: CursorMembershipResponse) => {
		const markdown = new vscode.MarkdownString();
		markdown.isTrusted = true;
		markdown.supportHtml = true;
		markdown.supportThemeIcons = true;

		const startDate = new Date(usage.startOfMonth);
		const options: Intl.DateTimeFormatOptions = {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
			timeZone: 'Asia/Shanghai'
		};
		const formattedDate = startDate.toLocaleString('zh-CN', options).replace(/\//g, '-');

		markdown.appendMarkdown(`### Cursor 使用情况\n\n`);
		markdown.appendMarkdown(`**会员状态:** ${membership.membershipType === 'free_trial' ?
			`试用期（剩余 ${membership.daysRemainingOnTrial} 天）` :
			membership.membershipType}\n\n`);
		markdown.appendMarkdown(`**开始时间:** ${formattedDate}\n\n`);

		markdown.appendMarkdown(`#### 请求数量\n`);
		markdown.appendMarkdown(`- 使用情况: \`${usage['gpt-4'].numRequests}\` / ${usage['gpt-4'].maxRequestUsage}\n`);
		markdown.appendMarkdown(`- 总请求次数: \`${usage['gpt-4'].numRequestsTotal}\`\n`);
		markdown.appendMarkdown(`- Token 使用量: \`${usage['gpt-4'].numTokens}\`\n`);

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
					updateTooltip(usage, membership);
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
	const updateInterval = 5 * 60 * 1000; // 5分钟更新一次
	setInterval(async () => {
		const tokenInfo = await getCursorToken();
		if (tokenInfo) {
			const [usage, membership] = await Promise.all([
				getCursorUsage(tokenInfo.userId, tokenInfo.token),
				getCursorMembership(tokenInfo.token)
			]);
			if (usage && membership) {
				updateStatusBar(usage);
				updateTooltip(usage, membership);
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
async function getCursorToken(): Promise<{ userId: string, token: string } | undefined> {
	try {
		const dbPath = getCursorDBPath();
		if (!fs.existsSync(dbPath)) {
			return undefined;
		}

		const dbBuffer = fs.readFileSync(dbPath);
		const SQL = await initSqlJs();
		const db = new SQL.Database(new Uint8Array(dbBuffer));

		const result = db.exec("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'");

		if (!result.length || !result[0].values.length) {
			db.close();
			return undefined;
		}

		const token = result[0].values[0][0] as string;
		const decoded = jwt.decode(token, { complete: true });

		if (!decoded?.payload?.sub) {
			db.close();
			return undefined;
		}

		const userId = decoded.payload.sub.toString().split('|')[1];
		const sessionToken = `${userId}%3A%3A${token}`;
		db.close();
		return { userId, token: sessionToken };
	} catch (error) {
		console.error('获取 Token 失败:', error);
		return undefined;
	}
}

// 添加获取使用量的函数
async function getCursorUsage(userId: string, token: string): Promise<CursorUsageResponse | undefined> {
	try {
		const options = {
			hostname: 'www.cursor.com',
			path: `/api/usage?user=${encodeURIComponent(userId)}`,
			method: 'GET',
			headers: {
				'Cookie': `WorkosCursorSessionToken=${token}`,
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
			hostname: 'www.cursor.com',
			path: '/api/auth/stripe',
			method: 'GET',
			headers: {
				'Cookie': `WorkosCursorSessionToken=${token}`,
				'Referer': 'https://www.cursor.com/settings',
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