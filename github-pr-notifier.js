// GitHub PR Slack通知スクリプト
const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');
const axios = require('axios');
const os = require('os');
require('dotenv').config();

// キャッシュディレクトリの設定（ローカルプロジェクトディレクトリに保存）
const CACHE_DIR = path.join(__dirname, '.cache');
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
const currentTime = new Date();
let cache = {
  lastChecked: currentTime.toISOString(),  // 初期値を現在時刻に設定
  notifiedComments: [],
  notifiedReviews: [], // レビュー通知用のキャッシュを追加
  assignedPRs: [],
  firstRunTime: currentTime.toISOString()  // 初回実行時刻を記録
};

if (fs.existsSync(CACHE_FILE)) {
  try {
    const cacheContent = fs.readFileSync(CACHE_FILE, 'utf-8');
    cache = JSON.parse(cacheContent);
    // 古いキャッシュ形式に対応するための初期化
    if (!cache.notifiedReviews) {
      cache.notifiedReviews = [];
    }
    // firstRunTimeがなければ追加
    if (!cache.firstRunTime) {
      cache.firstRunTime = cache.lastChecked;
    }
  } catch (error) {
    console.log('キャッシュファイルが破損しています。新しいキャッシュを作成します。');
  }
}

// GitHub API クライアント
const octokit = new Octokit({
  auth: config.github.token
});

// botかどうかを判定する関数
function isBot(user) {
  return user.type === 'Bot' || user.login.endsWith('[bot]');
}


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
  
  // 最終チェック時刻を取得
  const lastChecked = new Date(cache.lastChecked);
  console.log(`最終チェック: ${lastChecked}`);
  const since = lastChecked.toISOString();
  console.log(`チェック開始: ${since}`);
  
  let assignedPRs = cache.assignedPRs;
  if (!assignedPRs || assignedPRs.length === 0) {
    assignedPRs = await updateAssignedPRs();
  }
  
  const notifiedComments = new Set(cache.notifiedComments);
  const newNotifiedComments = [...notifiedComments];
  // console.log(`通知済みコメント数: ${notifiedComments.size}`);
  // console.log(`通知済みコメント: ${Array.from(notifiedComments)}`);
  
  // レビュー通知用のキャッシュ
  const notifiedReviews = new Set(cache.notifiedReviews);
  const newNotifiedReviews = [...notifiedReviews];
  // console.log(`通知済みレビュー数: ${notifiedReviews.size}`);
  
  for (const pr of assignedPRs) {
    try {
      // PRのコメントを取得
      const issueCommentsResponse = await octokit.issues.listComments({
        owner: pr.owner,
        repo: pr.repo,
        issue_number: pr.number,
        since: since
      });
      // console.log(`PR #${pr.number}のコメントを取得しました`);
      // console.log(issueCommentsResponse.data);
      
      // レビューコメントを取得
      const reviewCommentsResponse = await octokit.pulls.listReviewComments({
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.number,
        since: since
      });
      // console.log(`PR #${pr.number}のレビューコメントを取得しました`);
      // console.log(reviewCommentsResponse.data);
      
      // PRレビュー（承認や変更要求など）を取得
      const reviewsResponse = await octokit.pulls.listReviews({
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.number
      });
      // console.log(`PR #${pr.number}のレビューを取得しました`);
      // console.log(reviewsResponse.data);
      
      // レビューをフィルタリング
      const newReviews = reviewsResponse.data.filter(review => {
        const reviewDate = new Date(review.submitted_at);
        const reviewer = review.user.login;
        // 自分自身のレビューは除外する
        return reviewDate > lastChecked && 
               !notifiedReviews.has(review.id.toString()) &&
               reviewer !== username; // 自分のレビューは除外
      });
      
      // 両方のコメントを処理
      const allComments = [
        ...issueCommentsResponse.data,
        ...reviewCommentsResponse.data
      ];
      
      const newComments = allComments.filter(comment => {
        const commenter = comment.user.login;
        // 自分自身のコメントは除外する
        return !notifiedComments.has(comment.id.toString()) && 
               commenter !== username; // 自分のコメントは除外
      });
      
      // 新しいコメントがあれば通知
      for (const comment of newComments) {
        const commenter = comment.user.login;
        const isBotComment = isBot(comment.user);
        
        // botの場合は通知しない
        if (isBotComment) {
          console.log(`Bot ${commenter} からのコメントをスキップしました`);
          newNotifiedComments.push(comment.id.toString());
          continue;
        }
        
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
      
      // 新しいレビューがあれば通知
      for (const review of newReviews) {
        const reviewer = review.user.login;
        let reviewState = review.state;
        let reviewBody = review.body || '';
        
        // レビューの状態をわかりやすい日本語に変換
        let stateMessage = '';
        let stateEmoji = '';
        
        switch (reviewState) {
          case 'APPROVED':
            stateMessage = '承認しました :white_check_mark:';
            stateEmoji = ':white_check_mark:';
            break;
          case 'CHANGES_REQUESTED':
            stateMessage = '変更を要求しています :warning:';
            stateEmoji = ':warning:';
            break;
          case 'COMMENTED':
            stateMessage = 'コメントしました :speech_balloon:';
            stateEmoji = ':speech_balloon:';
            break;
          case 'DISMISSED':
            stateMessage = 'レビューを却下しました :x:';
            stateEmoji = ':x:';
            break;
          default:
            stateMessage = `レビューしました (${reviewState})`;
            stateEmoji = ':eyes:';
        }
        
        // レビューコメントが長い場合は省略
        if (reviewBody.length > 100) {
          reviewBody = reviewBody.substring(0, 100) + '...';
        }
        
        const title = `${pr.repo} PR #${pr.number}に新しいレビュー`;
        const message = `${reviewer}が${stateMessage}${reviewBody ? `: ${reviewBody}` : ''}`;
        const url = review.html_url || pr.url;
        
        showNotification(title, message, url, {
          repo: pr.repo,
          pr_number: pr.number,
          pr_title: pr.title,
          pr_url: pr.url,
          reviewer,
          review_state: reviewState,
          review_state_message: stateMessage,
          review_state_emoji: stateEmoji,
          review_body: reviewBody
        });
        
        // 通知済みリストに追加
        newNotifiedReviews.push(review.id.toString());
      }
    } catch (error) {
      console.error(`${pr.owner}/${pr.repo} PR #${pr.number} の処理中にエラー:`, error.message);
    }
  }
  
  // 最終チェック時間と通知済みIDを更新
  cache.lastChecked = new Date().toISOString();
  // 最新1000件だけ保持
  cache.notifiedComments = newNotifiedComments.slice(-1000);
  cache.notifiedReviews = newNotifiedReviews.slice(-1000);
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
    const { repo, pr_number, pr_title, commenter, comment_body, 
            reviewer, review_state, review_state_message, review_state_emoji, review_body } = extraData;
    
    // Slackメッセージブロックを構築
    let blocks = [
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `*PR:* <${url}|${repo} #${pr_number}> - ${pr_title}`
        }
      }
    ];
    
    // コメント通知の場合
    if (commenter) {
      blocks.push({
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `*@${commenter}*: ${comment_body}`
        }
      });
    }
    
    // レビュー通知の場合
    if (reviewer) {
      blocks.push({
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `*@${reviewer}* ${review_state_message}${review_body ? `\n>${review_body}` : ''}`
        }
      });
    }
    
    // アクションボタン
    blocks.push({
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": {
            "type": "plain_text",
            "text": reviewer ? "レビューを確認" : "コメントを確認",
            "emoji": true
          },
          "url": url
        }
      ]
    });
    
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
      console.log(`\n${now.toLocaleString()} コメントとレビューをチェック中...`);
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
