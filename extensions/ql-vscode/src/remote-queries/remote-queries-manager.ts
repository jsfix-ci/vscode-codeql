import { CancellationToken, commands, ExtensionContext, Uri, window } from 'vscode';
import { nanoid } from 'nanoid';
import * as path from 'path';
import * as fs from 'fs-extra';

import { Credentials } from '../authentication';
import { CodeQLCliServer } from '../cli';
import { ProgressCallback } from '../commandRunner';
import { createTimestampFile, showAndLogErrorMessage, showInformationMessageWithAction } from '../helpers';
import { Logger } from '../logging';
import { runRemoteQuery } from './run-remote-query';
import { RemoteQueriesInterfaceManager } from './remote-queries-interface';
import { RemoteQuery } from './remote-query';
import { RemoteQueriesMonitor } from './remote-queries-monitor';
import { getRemoteQueryIndex } from './gh-actions-api-client';
import { RemoteQueryResultIndex } from './remote-query-result-index';
import { RemoteQueryResult } from './remote-query-result';
import { DownloadLink } from './download-link';
import { AnalysesResultsManager } from './analyses-results-manager';
import { assertNever } from '../pure/helpers-pure';
import { RemoteQueryHistoryItem } from './remote-query-history-item';
import { QueryHistoryManager } from '../query-history';
import { QueryStatus } from '../query-status';

const autoDownloadMaxSize = 300 * 1024;
const autoDownloadMaxCount = 100;

export class RemoteQueriesManager {
  private readonly remoteQueriesMonitor: RemoteQueriesMonitor;
  private readonly analysesResultsManager: AnalysesResultsManager;
  private readonly interfaceManager: RemoteQueriesInterfaceManager;

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly cliServer: CodeQLCliServer,
    private readonly qhm: QueryHistoryManager,
    private readonly storagePath: string,
    logger: Logger,
  ) {
    this.analysesResultsManager = new AnalysesResultsManager(ctx, storagePath, logger);
    this.interfaceManager = new RemoteQueriesInterfaceManager(ctx, logger, this.analysesResultsManager);
    this.remoteQueriesMonitor = new RemoteQueriesMonitor(ctx, logger);
  }

  public async runRemoteQuery(
    uri: Uri | undefined,
    progress: ProgressCallback,
    token: CancellationToken
  ): Promise<void> {
    const credentials = await Credentials.initialize(this.ctx);

    const querySubmission = await runRemoteQuery(
      this.cliServer,
      credentials, uri || window.activeTextEditor?.document.uri,
      false,
      progress,
      token);

    if (querySubmission && querySubmission.query) {
      void commands.executeCommand('codeQL.monitorRemoteQuery', querySubmission.query);
    }
  }

  public async monitorRemoteQuery(
    query: RemoteQuery,
    cancellationToken: CancellationToken
  ): Promise<void> {
    const queryId = this.createQueryId(query.queryName);
    await this.prepareStorageDirectory(queryId);
    await this.storeFile(queryId, 'query.json', query);

    const queryHistoryItem = new RemoteQueryHistoryItem(query.queryName, queryId, this.storagePath);
    this.qhm.addQuery(queryHistoryItem);

    const credentials = await Credentials.initialize(this.ctx);

    const queryWorkflowResult = await this.remoteQueriesMonitor.monitorQuery(query, cancellationToken);

    const executionEndTime = new Date();

    if (queryWorkflowResult.status === 'CompletedSuccessfully') {
      const resultIndex = await getRemoteQueryIndex(credentials, query);
      if (!resultIndex) {
        void showAndLogErrorMessage(`There was an issue retrieving the result for the query ${query.queryName}`);
        return;
      }
      queryHistoryItem.completed = true;
      queryHistoryItem.status = QueryStatus.Completed;
      const queryResult = this.mapQueryResult(executionEndTime, resultIndex, queryId);

      await this.storeFile(queryId, 'query-result.json', queryResult);

      // Kick off auto-download of results in the background.
      void commands.executeCommand('codeQL.autoDownloadRemoteQueryResults', queryResult);

      // Ask if the user wants to open the results in the background.
      void this.askToOpenResults(query, queryResult).then(
        () => { /* do nothing */ },
        err => {
          void showAndLogErrorMessage(err);
        }
      );
    } else if (queryWorkflowResult.status === 'CompletedUnsuccessfully') {
      queryHistoryItem.failureReason = queryWorkflowResult.error;
      queryHistoryItem.status = QueryStatus.Failed;
      await showAndLogErrorMessage(`Remote query execution failed. Error: ${queryWorkflowResult.error}`);
    } else if (queryWorkflowResult.status === 'Cancelled') {
      queryHistoryItem.failureReason = 'Cancelled';
      queryHistoryItem.status = QueryStatus.Failed;
      await showAndLogErrorMessage('Remote query monitoring was cancelled');
    } else if (queryWorkflowResult.status === 'InProgress') {
      // Should not get here
      await showAndLogErrorMessage(`Unexpected status: ${queryWorkflowResult.status}`);
    } else {
      // Ensure all cases are covered
      assertNever(queryWorkflowResult.status);
    }
    this.qhm.refreshTreeView();
  }

  public async autoDownloadRemoteQueryResults(
    queryResult: RemoteQueryResult,
    token: CancellationToken
  ): Promise<void> {
    const analysesToDownload = queryResult.analysisSummaries
      .filter(a => a.fileSizeInBytes < autoDownloadMaxSize)
      .slice(0, autoDownloadMaxCount)
      .map(a => ({
        nwo: a.nwo,
        resultCount: a.resultCount,
        downloadLink: a.downloadLink,
        fileSize: String(a.fileSizeInBytes)
      }));

    await this.analysesResultsManager.downloadAnalysesResults(
      analysesToDownload,
      token,
      results => this.interfaceManager.setAnalysisResults(results));
  }

  private mapQueryResult(executionEndTime: Date, resultIndex: RemoteQueryResultIndex, queryId: string): RemoteQueryResult {
    const analysisSummaries = resultIndex.items.map(item => ({
      nwo: item.nwo,
      resultCount: item.resultCount,
      fileSizeInBytes: item.sarifFileSize ? item.sarifFileSize : item.bqrsFileSize,
      downloadLink: {
        id: item.artifactId.toString(),
        urlPath: `${resultIndex.artifactsUrlPath}/${item.artifactId}`,
        innerFilePath: item.sarifFileSize ? 'results.sarif' : 'results.bqrs',
        queryId,
      } as DownloadLink
    }));

    return {
      executionEndTime,
      analysisSummaries,
    };
  }

  private async askToOpenResults(query: RemoteQuery, queryResult: RemoteQueryResult): Promise<void> {
    const totalResultCount = queryResult.analysisSummaries.reduce((acc, cur) => acc + cur.resultCount, 0);
    const message = `Query "${query.queryName}" run on ${query.repositories.length} repositories and returned ${totalResultCount} results`;

    const shouldOpenView = await showInformationMessageWithAction(message, 'View');
    if (shouldOpenView) {
      await this.interfaceManager.showResults(query, queryResult);
    }
  }

  /**
   * Generates a unique id for this query, suitable for determining the storage location for the downloaded query artifacts.
   * @param queryName
   * @returns
   */
  private createQueryId(queryName: string): string {
    return `${queryName}-${nanoid()}`;

  }

  /**
   * Prepares a directory for storing analysis results for a single query run.
   * This directory contains a timestamp file, which will be
   * used by the query history manager to determine when the directory
   * should be deleted.
   *
   * @param queryName The name of the query that was run.
   */
  private async prepareStorageDirectory(queryId: string): Promise<void> {
    await createTimestampFile(path.join(this.storagePath, queryId));
  }

  private async storeFile(queryId: string, fileName: string, obj: any): Promise<void> {
    const filePath = path.join(this.storagePath, queryId, fileName);
    await fs.writeFile(filePath, JSON.stringify(obj, null, 2), 'utf8');
  }

}
