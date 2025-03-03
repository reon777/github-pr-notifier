// GitHub PR Slack通知スクリプト
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Octokit } = require('@octokit/rest');
const axios = require('axios');
const os = require('os');
const ini = require('ini');

// 設定ファイルのパス
const CONFIG_DIR = path.join(os.homedir(), '.github-pr-notifier');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.ini');
const CACHE_FILE = path.join(CONFIG_DIR, 'cache.json');

// 設定ディレクトリが存在しない場合は作成
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

// デフォルト設定
const DEFAULT_CONFIG = {
  github: {
    token: '',
    username: '',
    check_interval: 300, // 5分（秒単位）
  },
  notification: {
    slack_webhook: '', // SlackのWebhook URL
    slack_channel: '', // オプション: 特定のチャンネルを指定する場合
    slack_username: 'GitHub PR Notifier', // 通知に表示される名前
    slack_icon_emoji: ':bell:' // 通知アイコン
  }
};

// 設定ファイルの読み込み
let config;
if (fs.existsSync(CONFIG_FILE)) {
  const configContent = fs.readFileSync(CONFIG_FILE, 'utf-8');
  config = ini.parse(configContent);
} else {
  config = DEFAULT_CONFIG;
  fs.writeFileSync(CONFIG_FILE, ini.stringify(config));
  console.log(`設定ファイルを作成しました: ${CONFIG_FILE}`);
  console.log('GitHub トークンとユーザー名、SlackのWebhook URLを設定してください');
}

// キャッシュファイルの読み込み
let cache = {
  last_checked: new Date().toISOString(),
  notified_comments: [],
  assigned_prs: []
};

if (fs.existsSync(CACHE_FILE)) {
  try {
    const cacheContent = fs.readFileSync(CACHE_FILE, 'utf-8');
    cache = JSON.parse(cacheContent);
  } catch (error) {
    console.log('キャッシュファイルが破損しています。新しいキャッシュを作成します。');
  }
}

// GitHub API クライアント
const octokit = new Octokit({
  auth: config.github.token
});

// GitHub APIヘルパー関数
async function updateAssignedPRs() {
  const username = config.github.username;
  const token = config.github.token;
  
  if (!username || !token) {
    console.log('GitHub設定が不完全です。設定ファイルを確認してください。');
    return [];
  }
  
  try {
    // 自分がアサインされているPR
    const assignedResponse = await octokit.search.issuesAndPullRequests({
      q: `is:pr is:open assignee:${username}`
    });
    
    // 自分が作成したPR
    const createdResponse = await octokit.search.issuesAndPullRequests({
      q: `is:pr is:open author:${username}`
    });
    
    // 結果を組み合わせて重複排除
    const allItems = [...assignedResponse.data.items, ...createdResponse.data.items];
    const uniquePRs = [];
    const seenPRs = new Set();
    
    for (const item of allItems) {
      const repoUrl = item.repository_url;
      const [owner, repo] = repoUrl.replace('https://api.github.com/repos/', '').split('/');
      const prKey = `${owner}/${repo}/${item.number}`;
      
      if (!seenPRs.has(prKey)) {
        seenPRs.add(prKey);
        uniquePRs.push({
          owner,
          repo,
          number: item.number,
          title: item.title,
          url: item.html_url
        });
      }
    }
    
    cache.assigned_prs = uniquePRs;
    saveCache();
    
    return uniquePRs;
  } catch (error) {
    console.error('PR一覧の更新エラー:', error.message);
    return [];
  }
}

async function checkForNewComments() {
  const username = config.github.username;
  const lastChecked = new Date(cache.last_checked);
  const since = lastChecked.toISOString();
  
  let assignedPRs = cache.assigned_prs;
  if (!assignedPRs || assignedPRs.length === 0) {
    assignedPRs = await updateAssignedPRs();
  }
  
  const notifiedComments = new Set(cache.notified_comments);
  const newNotifiedComments = [...notifiedComments];
  
  for (const pr of assignedPRs) {
    try {
      // PRのコメントを取得
      const issueCommentsResponse = await octokit.issues.listComments({
        owner: pr.owner,
        repo: pr.repo,
        issue_number: pr.number,
        since: since
      });
      
      // レビューコメントを取得
      const reviewCommentsResponse = await octokit.pulls.listReviewComments({
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.number,
        since: since
      });
      
      // 両方のコメントを処理
      const allComments = [
        ...issueCommentsResponse.data,
        ...reviewCommentsResponse.data
      ];
      
      const newComments = allComments.filter(comment => 
        comment.user.login !== username && // 自分のコメントを除外
        !notifiedComments.has(comment.id.toString()) // 既に通知済みのコメントを除外
      );
      
      // 新しいコメントがあれば通知
      for (const comment of newComments) {
        const commenter = comment.user.login;
        let commentBody = comment.body;
        if (commentBody.length > 100) {
          commentBody = commentBody.substring(0, 100) + '...';
        }
        
        const title = `${pr.repo} PR #${pr.number}に新しいコメント`;
        const message = `${commenter}: ${commentBody}`;
        const url = comment.html_url;
        
        showNotification(title, message, url, {
          repo: pr.repo,
          pr_number: pr.number,
          pr_title: pr.title,
          pr_url: pr.url,
          commenter,
          comment_body: commentBody
        });
        
        // 通知済みリストに追加
        newNotifiedComments.push(comment.id.toString());
      }
    } catch (error) {
      console.error(`${pr.owner}/${pr.repo} PR #${pr.number} の処理中にエラー:`, error.message);
    }
  }
  
  // 最終チェック時間と通知済みコメントIDを更新
  cache.last_checked = new Date().toISOString();
  // 最新1000件だけ保持
  cache.notified_comments = newNotifiedComments.slice(-1000);
  saveCache();
}

function showNotification(title, message, url = null, extraData = {}) {
  console.log(`\n${title}`);
  console.log(`${message}`);
  if (url) console.log(`URL: ${url}`);
  
  // Slack通知
  sendSlackNotification(title, message, url, extraData);
}

async function sendSlackNotification(title, message, url, extraData = {}) {
  const webhookUrl = config.notification.slack_webhook;
  
  if (!webhookUrl) {
    console.log('Slack Webhook URLが設定されていません。設定ファイルを確認してください。');
    return;
  }
  
  try {
    const { repo, pr_number, pr_title, commenter, comment_body } = extraData;
    
    // Slackメッセージブロックを構築
    const blocks = [
      {
        "type": "header",
        "text": {
          "type": "plain_text",
          "text": title,
          "emoji": true
        }
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `*PR:* <${url}|${repo} #${pr_number}> - ${pr_title}`
        }
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `*@${commenter}*: ${comment_body}`
        }
      },
      {
        "type": "actions",
        "elements": [
          {
            "type": "button",
            "text": {
              "type": "plain_text",
              "text": "コメントを確認",
              "emoji": true
            },
            "url": url
          }
        ]
      },
      {
        "type": "context",
        "elements": [
          {
            "type": "mrkdwn",
            "text": `通知時刻: ${new Date().toLocaleString()}`
          }
        ]
      }
    ];
    
    // Slackに送信するペイロード
    const payload = {
      channel: config.notification.slack_channel || '',
      username: config.notification.slack_username || 'GitHub PR Notifier',
      icon_emoji: config.notification.slack_icon_emoji || ':bell:',
      blocks: blocks
    };
    
    // Webhookを使用して送信
    await axios.post(webhookUrl, payload);
    console.log('Slack通知を送信しました');
  } catch (error) {
    console.error('Slack通知エラー:', error.message);
  }
}

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function main() {
  console.log('GitHub PR Slack通知スクリプトを開始しました');
  
  if (!config.github.token || !config.github.username) {
    console.log('GitHub設定が不完全です。以下のファイルを編集してください:');
    console.log(CONFIG_FILE);
    return;
  }
  
  if (!config.notification.slack_webhook) {
    console.log('Slack Webhookが設定されていません。以下のファイルを編集してください:');
    console.log(CONFIG_FILE);
    console.log('Slack Webhookの取得方法: https://api.slack.com/messaging/webhooks');
  }
  
  const checkInterval = parseInt(config.github.check_interval) * 1000;
  
  try {
    // 最初のPR一覧取得
    await updateAssignedPRs();
    console.log(`監視中のPR: ${cache.assigned_prs.length}件`);
    
    // 定期チェック
    setInterval(async () => {
      const now = new Date();
      console.log(`\n${now.toLocaleString()} コメントをチェック中...`);
      await checkForNewComments();
      
      // 30分ごとにPR一覧を更新
      if (now.getMinutes() % 30 === 0) {
        await updateAssignedPRs();
      }
    }, checkInterval);
    
    // 初回チェック
    await checkForNewComments();
  } catch (error) {
    console.error('エラーが発生しました:', error.message);
  }
}

// スクリプト実行
main().catch(error => {
  console.error('致命的なエラー:', error);
});
