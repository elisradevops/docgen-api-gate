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
}
export interface UploadProperties {
  bucketName: string;
  fileName: string;
  AwsAccessKeyId: string;
  AwsSecretAccessKey: string;
  Region: string;
  ServiceUrl: string;
}
export interface ContentControl {
  title: string;
  type: string;
  skin: string;
  headingLevel: number;
  data: DataDescriptor;
  isExcelSpreadsheet: boolean;
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
}

export enum RequirementsTraceabilityMode {
  CustomerRequirementId,
  RequirementId,
}
