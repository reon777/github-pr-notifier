// GitHub PR Slack通知スクリプト
const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');
const axios = require('axios');
const os = require('os');
require('dotenv').config();

// キャッシュディレクトリの設定
const CACHE_DIR = path.join(os.homedir(), '.github-pr-notifier');
const CACHE_FILE = path.join(CACHE_DIR, 'cache.json');

// キャッシュディレクトリが存在しない場合は作成
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// 環境変数からの設定読み込み
const config = {
  github: {
    token: process.env.GITHUB_TOKEN || '',
    username: process.env.GITHUB_USERNAME || '',
    checkInterval: parseInt(process.env.CHECK_INTERVAL || '300')
  },
  slack: {
    webhook: process.env.SLACK_WEBHOOK || '',
    username: process.env.SLACK_USERNAME || 'GitHub PR Notifier',
    iconEmoji: process.env.SLACK_ICON_EMOJI || ':bell:'
  }
};

// .envファイルが存在しない場合は作成
if (!fs.existsSync('.env')) {
  const envContent = `# GitHub設定
GITHUB_TOKEN=
GITHUB_USERNAME=
CHECK_INTERVAL=300

# Slack設定
SLACK_WEBHOOK=
SLACK_CHANNEL=
SLACK_USERNAME=GitHub PR Notifier
SLACK_ICON_EMOJI=:bell:
`;
  fs.writeFileSync('.env', envContent);
  console.log('.envファイルを作成しました。GitHub トークンとユーザー名、SlackのWebhook URLを設定してください。');
}

// キャッシュファイルの読み込み
let cache = {
  lastChecked: new Date().toISOString(),
  notifiedComments: [],
  assignedPRs: []
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
    console.log('GitHub設定が不完全です。.envファイルを確認してください。');
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
    
    cache.assignedPRs = uniquePRs;
    saveCache();
    
    return uniquePRs;
  } catch (error) {
    console.error('PR一覧の更新エラー:', error.message);
    return [];
  }
}

async function checkForNewComments() {
  const username = config.github.username;
  const lastChecked = new Date(cache.lastChecked);
  const since = lastChecked.toISOString();
  
  let assignedPRs = cache.assignedPRs;
  if (!assignedPRs || assignedPRs.length === 0) {
    assignedPRs = await updateAssignedPRs();
  }
  
  const notifiedComments = new Set(cache.notifiedComments);
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
  cache.lastChecked = new Date().toISOString();
  // 最新1000件だけ保持
  cache.notifiedComments = newNotifiedComments.slice(-1000);
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
  const webhookUrl = config.slack.webhook;
  
  if (!webhookUrl) {
    console.log('Slack Webhook URLが設定されていません。.envファイルを確認してください。');
    return;
  }
  
  try {
    const { repo, pr_number, pr_title, commenter, comment_body } = extraData;
    
    // Slackメッセージブロックを構築
    const blocks = [
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
      }
    ];
    
    // Slackに送信するペイロード
    const payload = {
      username: config.slack.username || 'GitHub PR Notifier',
      icon_emoji: config.slack.iconEmoji || ':bell:',
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
    console.log('GitHub設定が不完全です。.envファイルを編集してください。');
    return;
  }
  
  if (!config.slack.webhook) {
    console.log('Slack Webhookが設定されていません。.envファイルを編集してください。');
    console.log('Slack Webhookの取得方法: https://api.slack.com/messaging/webhooks');
    return;
  }
  
  const checkInterval = config.github.checkInterval * 1000;
  
  try {
    // 最初のPR一覧取得
    await updateAssignedPRs();
    console.log(`監視中のPR: ${cache.assignedPRs.length}件`);
    
    // 監視中のPRの詳細をログに出力
    if (cache.assignedPRs.length > 0) {
      console.log('監視中のPR一覧:');
      cache.assignedPRs.forEach((pr, index) => {
        console.log(`  ${index + 1}. ${pr.owner}/${pr.repo} #${pr.number}: ${pr.title}`);
      });
    }
    
    // 定期チェック
    setInterval(async () => {
      const now = new Date();
      console.log(`\n${now.toLocaleString()} コメントをチェック中...`);
      await checkForNewComments();
      
      // 30分ごとにPR一覧を更新
      if (now.getMinutes() % 30 === 0) {
        await updateAssignedPRs();
        console.log(`監視中のPR: ${cache.assignedPRs.length}件`);
        if (cache.assignedPRs.length > 0) {
          console.log('監視中のPR一覧:');
          cache.assignedPRs.forEach((pr, index) => {
            console.log(`  ${index + 1}. ${pr.owner}/${pr.repo} #${pr.number}: ${pr.title}`);
          });
        }
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
