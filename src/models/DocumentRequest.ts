export interface DocumentRequest {
  documentId?: string;
  templateFile: string;
  uploadProperties: UploadProperties;
  teamProjectName: string;
  tfsCollectionUri: string;
  PAT: string;
  contentControls: ContentControl[];
  vcrmQueryId: string;
  userEmail: string;
  formattingSettings: FormattingSettings;
}
export interface UploadProperties {
  bucketName: string;
  fileName: string;
  createdBy?: string;
  inputSummary?: string;
  inputDetails?: string;
  AwsAccessKeyId: string;
  AwsSecretAccessKey: string;
  Region: string;
  ServiceUrl: string;
  EnableDirectDownload: boolean;
}
export interface ContentControl {
  title: string;
  type: string;
  skin: string;
  headingLevel: number;
  data: DataDescriptor;
  isExcelSpreadsheet: boolean;
}
export interface FormattingSettings {
  trimAdditionalSpacingInDescriptions: boolean;
  trimAdditionalSpacingInTables: boolean;
}
export interface DataDescriptor {
  type: string;
  queryId?: string;
  repoId?: string;
  from?: string; //for range of sha,piplines,dates
  to?: string; //for range of sha,piplines,dates
  rangeType?: string[];
  planId?: number;
  testSuiteArray?: number[];
  branchName?: string;
  linkTypeFilterArray?: string[];
  includeAttachments?: boolean;
  requestedByBuild?: boolean;
}

export enum RequirementsTraceabilityMode {
  CustomerRequirementId,
  RequirementId,
}
