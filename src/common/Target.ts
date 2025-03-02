/**
 * Copyright 2019 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Page, PageEmittedEvents } from './Page.js';
import { WebWorker } from './WebWorker.js';
import { CDPSession } from './Connection.js';
import { Browser, BrowserContext, IsPageTargetCallback } from './Browser.js';
import { Viewport } from './PuppeteerViewport.js';
import { Protocol } from 'devtools-protocol';
import { TaskQueue } from './TaskQueue.js';

/**
 * @public
 */
export class Target {
  private _targetInfo: Protocol.Target.TargetInfo;
  private _browserContext: BrowserContext;

  private _sessionFactory: () => Promise<CDPSession>;
  private _ignoreHTTPSErrors: boolean;
  private _defaultViewport?: Viewport;
  private _pagePromise?: Promise<Page>;
  private _workerPromise?: Promise<WebWorker>;
  private _screenshotTaskQueue: TaskQueue;
  /**
   * @internal
   */
  _initializedPromise: Promise<boolean>;
  /**
   * @internal
   */
  _initializedCallback!: (x: boolean) => void;
  /**
   * @internal
   */
  _isClosedPromise: Promise<void>;
  /**
   * @internal
   */
  _closedCallback!: () => void;
  /**
   * @internal
   */
  _isInitialized: boolean;
  /**
   * @internal
   */
  _targetId: string;
  /**
   * @internal
   */
  _isPageTargetCallback: IsPageTargetCallback;

  /**
   * @internal
   */
  constructor(
    targetInfo: Protocol.Target.TargetInfo,
    browserContext: BrowserContext,
    sessionFactory: () => Promise<CDPSession>,
    ignoreHTTPSErrors: boolean,
    defaultViewport: Viewport | null,
    screenshotTaskQueue: TaskQueue,
    isPageTargetCallback: IsPageTargetCallback
  ) {
    this._targetInfo = targetInfo;
    this._browserContext = browserContext;
    this._targetId = targetInfo.targetId;
    this._sessionFactory = sessionFactory;
    this._ignoreHTTPSErrors = ignoreHTTPSErrors;
    this._defaultViewport = defaultViewport ?? undefined;
    this._screenshotTaskQueue = screenshotTaskQueue;
    this._isPageTargetCallback = isPageTargetCallback;
    this._initializedPromise = new Promise<boolean>(
      (fulfill) => (this._initializedCallback = fulfill)
    ).then(async (success) => {
      if (!success) return false;
      const opener = this.opener();
      if (!opener || !opener._pagePromise || this.type() !== 'page')
        return true;
      const openerPage = await opener._pagePromise;
      if (!openerPage.listenerCount(PageEmittedEvents.Popup)) return true;
      const popupPage = await this.page();
      openerPage.emit(PageEmittedEvents.Popup, popupPage);
      return true;
    });
    this._isClosedPromise = new Promise<void>(
      (fulfill) => (this._closedCallback = fulfill)
    );
    this._isInitialized =
      !this._isPageTargetCallback(this._targetInfo) ||
      this._targetInfo.url !== '';
    if (this._isInitialized) this._initializedCallback(true);
  }

  /**
   * Creates a Chrome Devtools Protocol session attached to the target.
   */
  createCDPSession(): Promise<CDPSession> {
    return this._sessionFactory();
  }

  /**
   * @internal
   */
  _getTargetInfo(): Protocol.Target.TargetInfo {
    return this._targetInfo;
  }

  /**
   * If the target is not of type `"page"` or `"background_page"`, returns `null`.
   */
  async page(): Promise<Page | null> {
    if (this._isPageTargetCallback(this._targetInfo) && !this._pagePromise) {
      this._pagePromise = this._sessionFactory().then((client) =>
        Page.create(
          client,
          this,
          this._ignoreHTTPSErrors,
          this._defaultViewport ?? null,
          this._screenshotTaskQueue
        )
      );
    }
    return (await this._pagePromise) ?? null;
  }

  /**
   * If the target is not of type `"service_worker"` or `"shared_worker"`, returns `null`.
   */
  async worker(): Promise<WebWorker | null> {
    if (
      this._targetInfo.type !== 'service_worker' &&
      this._targetInfo.type !== 'shared_worker'
    )
      return null;
    if (!this._workerPromise) {
      // TODO(einbinder): Make workers send their console logs.
      this._workerPromise = this._sessionFactory().then(
        (client) =>
          new WebWorker(
            client,
            this._targetInfo.url,
            () => {} /* consoleAPICalled */,
            () => {} /* exceptionThrown */
          )
      );
    }
    return this._workerPromise;
  }

  url(): string {
    return this._targetInfo.url;
  }

  /**
   * Identifies what kind of target this is.
   *
   * @remarks
   *
   * See {@link https://developer.chrome.com/extensions/background_pages | docs} for more info about background pages.
   */
  type():
    | 'page'
    | 'background_page'
    | 'service_worker'
    | 'shared_worker'
    | 'other'
    | 'browser'
    | 'webview' {
    const type = this._targetInfo.type;
    if (
      type === 'page' ||
      type === 'background_page' ||
      type === 'service_worker' ||
      type === 'shared_worker' ||
      type === 'browser' ||
      type === 'webview'
    )
      return type;
    return 'other';
  }

  /**
   * Get the browser the target belongs to.
   */
  browser(): Browser {
    return this._browserContext.browser();
  }

  /**
   * Get the browser context the target belongs to.
   */
  browserContext(): BrowserContext {
    return this._browserContext;
  }

  /**
   * Get the target that opened this target. Top-level targets return `null`.
   */
  opener(): Target | undefined {
    const { openerId } = this._targetInfo;
    if (!openerId) return;
    return this.browser()._targets.get(openerId);
  }

  /**
   * @internal
   */
  _targetInfoChanged(targetInfo: Protocol.Target.TargetInfo): void {
    this._targetInfo = targetInfo;

    if (
      !this._isInitialized &&
      (!this._isPageTargetCallback(this._targetInfo) ||
        this._targetInfo.url !== '')
    ) {
      this._isInitialized = true;
      this._initializedCallback(true);
      return;
    }
  }
}
