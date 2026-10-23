/** Approved notices for the maintainer's personal deployment. */
import { escapeHtml, repository } from './content.mjs';

export const legalUpdated = '2026-10-23';

const content = {
  en: {
    privacy: {
      title: 'Privacy policy',
      intro: 'Data practices for the maintainer’s personal, owner-only deployment.',
      sections: [
        ['scope', 'Scope and operator', [
          "This policy describes the maintainer's personal, owner-only deployment of ChatGPT Colab Plugin, whose Google OAuth application name is `colab-compute-mcp`. KaiQin04 operates that deployment for their own use. It is not a public hosted notebook service. Other people who deploy the open-source template operate separate installations and must provide information about their own data practices.",
        ]],
        ['permissions', 'Google data and permissions', [
          'The application requests `openid`, `https://www.googleapis.com/auth/userinfo.email`, and `https://www.googleapis.com/auth/colaboratory`. It uses Google identity information to bind the authorization to the owner and uses the Colab permission to inspect compute availability, manage authorized runtimes, execute requested notebook code, and transfer requested inputs and results.',
          'The base OAuth flow does not request Google Drive or `cloud-platform` permission. Notebook code may separately contact other services or request additional authorization; those actions are distinct from the base OAuth connection.',
        ]],
        ['storage', 'Storage and processing', [
          "The private backend stores the owner's platform identifier, Google account identifier, a masked email address, and an encrypted refresh token. Access tokens are obtained from Google as needed. The backend also stores notebook documents, code, execution records, outputs, and artifact metadata in its database, and saved artifact files in object storage. Code and inputs submitted for execution are processed in the owner's Google Colab runtime.",
          "The deployment uses ChatGPT Sites and its underlying database and object-storage services. When the owner accesses the application through ChatGPT, their chosen client can receive requested tool results, notebook outputs, and download links. Google, OpenAI, and infrastructure providers process data according to their applicable terms and privacy policies. This application policy does not override those providers' practices.",
        ]],
        ['sharing', 'Purpose and sharing', [
          "The application uses the data to provide the notebook functions requested by its owner. It does not include advertising or a feature for selling Google user data. It has no application-specific process for training a separate model on Google user data. Processing by a chosen AI client remains subject to that client's settings and policies.",
          'The backend requires owner access. Artifact download links grant temporary access to the associated file; anyone who receives a valid link may be able to use it until it expires. The owner should share such links only with intended recipients.',
        ]],
        ['retention', 'Retention and controls', [
          'Notebook records and saved outputs remain until removed by the owner or the deployment operator. Ordinary artifacts have a configured 30-day retention period, while pinned artifacts remain until unpinned or deleted. Expiration and physical deletion are separate: maintenance availability can delay removal from storage. Provider logs and backups may follow separate retention schedules.',
          "The owner can revoke the application's Google access through their Google Account connections settings. Revocation prevents future authorized Google access but does not by itself delete records already saved in the private backend, stop a running Colab runtime, or remove copies downloaded or shared elsewhere. Backend records and runtimes must be managed separately. The stored refresh grant can be replaced through a new authorization or removed by the operator from the deployment's storage.",
        ]],
        ['contact', 'Security and contact', [
          'The application uses HTTPS for supported network connections and encrypts stored refresh tokens. It intentionally avoids returning credential values in normal tool responses. No system can guarantee uninterrupted availability or protection against every incident.',
          "The operator and sole user of this deployment are the same person. General questions about the open-source project can be raised through the repository's issue tracker. Do not include personal data, credentials, notebook contents, or private deployment details in public issues. Users of other installations should contact their own operator.",
        ]],
      ],
    },
    terms: {
      title: 'Terms of use',
      intro: 'Use of the maintainer’s personal deployment and the open-source template.',
      sections: [
        ['personal', 'Personal deployment', [
          "The maintainer's `colab-compute-mcp` OAuth application supports a personal, owner-only deployment of ChatGPT Colab Plugin. Publishing its OAuth status does not offer public access to that deployment or provide shared Google accounts, Colab compute credits, or a hosted service for other users.",
        ]],
        ['compute', 'Accounts, compute, and instructions', [
          "The owner connects their own Google account and is responsible for reviewing requested permissions and instructions sent to the notebook. Execution uses that account's available Colab resources and credits. Runtime availability, parallel allocation, timeouts, and provider charges are controlled by the relevant providers; the integration does not guarantee a particular GPU, concurrency level, or completion time.",
          'The owner is responsible for having permission to process submitted data and for checking generated code and results. Long-running work and unsaved runtime files may be lost if a runtime terminates or authorization fails. Saving or downloading an artifact does not by itself validate its correctness.',
        ]],
        ['providers', 'Software and providers', [
          "The open-source software is provided under the repository's MIT License, including its warranty and liability provisions. These notices do not change that license. Google Colab, OpenAI services, and other connected services remain subject to their own applicable terms. The project is not affiliated with or endorsed by Google or OpenAI.",
          "The privacy policy explains the application's data handling. Other deployments of this template are independently operated and may have different settings, policies, or software versions.",
        ]],
      ],
    },
  },
  'zh-TW': {
    privacy: {
      title: '隱私權政策',
      intro: '維護者個人、僅擁有者部署的資料處理方式。',
      sections: [
        ['scope', '適用範圍與營運者', [
          '本政策說明 ChatGPT Colab Plugin 維護者的個人、僅擁有者部署；其 Google OAuth 應用程式名稱為 `colab-compute-mcp`。KaiQin04 營運此部署供自己使用，並非公開提供的託管 Notebook 服務。其他自行部署開源範本的人營運各自獨立的服務，應另行說明其資料處理方式。',
        ]],
        ['permissions', 'Google 資料與權限', [
          '應用程式要求 `openid`、`https://www.googleapis.com/auth/userinfo.email` 及 `https://www.googleapis.com/auth/colaboratory`。Google 身分資訊用於將授權綁定至擁有者；Colab 權限用於查詢可用運算資源、管理已授權的 runtime、執行所要求的 Notebook 程式，以及傳送所要求的輸入與結果。',
          '基本 OAuth 流程不要求 Google Drive 或 `cloud-platform` 權限。Notebook 程式可能另外連接其他服務或要求額外授權；這些行為與基本 OAuth 連線分開處理。',
        ]],
        ['storage', '儲存與處理', [
          '私人後端儲存擁有者的平台識別碼、Google 帳號識別碼、遮罩處理的電子郵件地址，以及加密的 refresh token，並依需要向 Google 取得 access token。後端也在資料庫中儲存 Notebook 文件、程式碼、執行紀錄、輸出與產物中繼資料，並在物件儲存空間中保存產物檔案。提交執行的程式與輸入由擁有者的 Google Colab runtime 處理。',
          '此部署使用 ChatGPT Sites 及其底層資料庫與物件儲存服務。擁有者透過 ChatGPT 存取應用程式時，所選的客戶端可接收要求的工具結果、Notebook 輸出與下載連結。Google、OpenAI 與基礎設施供應商依各自適用的條款及隱私權政策處理資料；本應用程式政策不取代這些供應商的資料處理規則。',
        ]],
        ['sharing', '用途與分享', [
          '應用程式使用資料提供擁有者要求的 Notebook 功能，未包含廣告或出售 Google 使用者資料的功能，也沒有應用程式專屬、利用 Google 使用者資料訓練其他模型的流程。所選 AI 客戶端的處理仍受該客戶端設定與政策規範。',
          '後端要求擁有者存取權限。產物下載連結提供相關檔案的暫時存取權；任何取得有效連結的人，在連結到期前都可能使用它。擁有者應只將連結分享給預定接收者。',
        ]],
        ['retention', '保存期限與控制', [
          'Notebook 紀錄與已保存輸出會保留到擁有者或部署營運者移除為止。一般產物設定為保存 30 天；釘選產物則保留到取消釘選或刪除。到期與實際刪除並非同一件事：維護作業的可用性可能延後從儲存空間移除資料。供應商日誌與備份可能適用不同的保存期限。',
          '擁有者可在 Google 帳戶的連結設定中撤銷應用程式的 Google 存取權。撤銷可阻止後續已授權的 Google 存取，但不會自動刪除已存入私人後端的紀錄、停止執行中的 Colab runtime，或移除已下載或分享至其他地方的副本。後端紀錄與 runtime 必須另行管理。儲存的 refresh 授權可透過重新授權替換，或由營運者從部署的儲存空間移除。',
        ]],
        ['contact', '安全與聯絡', [
          '應用程式在支援的網路連線中使用 HTTPS，並加密儲存的 refresh token。一般工具回應刻意避免傳回憑證值。任何系統都無法保證服務永不中斷或防範所有事件。',
          '此部署的營運者與唯一使用者是同一人。關於開源專案的一般問題可透過 repository 的 issue tracker 提出。請勿在公開 issue 中放入個人資料、憑證、Notebook 內容或私人部署細節。其他部署的使用者應聯絡各自的營運者。',
        ]],
      ],
    },
    terms: {
      title: '使用條款',
      intro: '維護者個人部署與開源範本的使用說明。',
      sections: [
        ['personal', '個人部署', [
          '維護者的 `colab-compute-mcp` OAuth 應用程式支援 ChatGPT Colab Plugin 的個人、僅擁有者部署。發布 OAuth 狀態不代表開放該部署供公眾存取，也不提供共用 Google 帳號、Colab 運算額度或供其他使用者使用的託管服務。',
        ]],
        ['compute', '帳號、運算與操作指示', [
          '擁有者連接自己的 Google 帳號，並負責檢查要求的權限及送往 Notebook 的操作指示。執行使用該帳號可用的 Colab 資源與額度。Runtime 供應、並行配置、逾時與供應商收費由相關供應商控制；本整合不保證特定 GPU、並行數量或完成時間。',
          '擁有者須確保有權處理提交的資料，並檢查產生的程式與結果。Runtime 終止或授權失敗可能造成長時間工作及尚未保存的 runtime 檔案遺失。保存或下載產物本身不代表已驗證其正確性。',
        ]],
        ['providers', '軟體與供應商', [
          '開源軟體依 repository 的 MIT License 提供，包括其中的擔保與責任條款。本說明不變更該授權。Google Colab、OpenAI 服務與其他連接服務仍受各自適用的條款規範。本專案與 Google 或 OpenAI 無隸屬關係，亦未獲其背書。',
          '隱私權政策說明本應用程式的資料處理方式。此範本的其他部署由各自營運者獨立管理，可能採用不同設定、政策或軟體版本。',
        ]],
      ],
    },
  },
};

export function legal(locale, kind, localHome) {
  const page = content[locale][kind];
  const zh = locale === 'zh-TW';
  const format = (text) => escapeHtml(text).replace(/`([^`]+)`/g, '<code class="cp-type-code">$1</code>');
  return {
    title: page.title,
    intro: page.intro,
    toc: page.sections.map(([id, title]) => `<li><a href="#${id}">${title}</a></li>`).join(''),
    body: page.sections.map(([id, title, paragraphs]) => `<section id="${id}"><h2 class="cp-type-heading">${title}</h2>${paragraphs.map((text) => `<p>${format(text)}</p>`).join('')}</section>`).join('\n')
      + `<p><a href="${localHome}${kind === 'privacy' ? 'terms' : 'privacy'}/">${kind === 'privacy' ? (zh ? '使用條款' : 'Terms of use') : (zh ? '隱私權政策' : 'Privacy policy')}</a> · <a href="${repository}/blob/main/LICENSE">MIT License</a> · <a href="${repository}/issues">${zh ? '專案一般問題' : 'General project questions'}</a></p>`,
  };
}
