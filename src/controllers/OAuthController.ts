import { Request, Response } from 'express';
import logger from '../util/logger';
import axios from 'axios';
import crypto from 'crypto';

/**
 * Controller for handling SharePoint Online OAuth authentication
 * Supports both ROPC (password) and Authorization Code Flow with PKCE
 */
export class OAuthController {
  // Store PKCE verifiers temporarily (in production, use Redis or similar)
  private pkceStore: Map<string, { verifier: string; state: string; timestamp: number }> = new Map();

  constructor() {
    // Clean up expired PKCE entries every 10 minutes
    setInterval(() => {
      const now = Date.now();
      const EXPIRY = 10 * 60 * 1000; // 10 minutes
      for (const [key, value] of this.pkceStore.entries()) {
        if (now - value.timestamp > EXPIRY) {
          this.pkceStore.delete(key);
        }
      }
    }, 10 * 60 * 1000);
  }
  /**
   * Exchange user credentials for an access token
   * POST /oauth/token
   * Body: { tenantId, clientId, clientSecret, username, password, siteUrl }
   */
  public async getToken(req: Request, res: Response): Promise<void> {
    try {
      const { tenantId, clientId, clientSecret, username, password, siteUrl } = req.body;

      // Use environment variables as defaults
      const envClientId = process.env.AZURE_CLIENT_ID;
      const envClientSecret = process.env.AZURE_CLIENT_SECRET;
      const envTenantId = process.env.AZURE_TENANT_ID;

      const finalClientId = clientId || envClientId;
      const finalClientSecret = clientSecret || envClientSecret;
      const finalTenantId = tenantId || envTenantId || 'common';

      if (!finalClientId || !finalClientSecret || !username || !password || !siteUrl) {
        res.status(400).json({ 
          success: false, 
          message: 'Missing required fields: clientId, clientSecret, username, password, siteUrl. Configure AZURE_CLIENT_ID and AZURE_CLIENT_SECRET in environment variables.' 
        });
        return;
      }

      // Extract SharePoint resource from site URL
      const url = new URL(siteUrl);
      const resource = `https://${url.hostname}`;
      const tenant = finalTenantId;

      // Use Resource Owner Password Credentials (ROPC) flow
      // Note: This is not recommended for production, but works for testing
      const tokenEndpoint = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

      const params = new URLSearchParams({
        client_id: finalClientId,
        scope: `${resource}/.default`,
        username: username,
        password: password,
        grant_type: 'password',
        client_secret: finalClientSecret,
      });

      logger.info(`Requesting OAuth token for SharePoint: ${resource}`);

      const response = await axios.post(tokenEndpoint, params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      res.status(200).json({
        success: true,
        token: {
          accessToken: response.data.access_token,
          expiresIn: response.data.expires_in,
          tokenType: response.data.token_type,
          refreshToken: response.data.refresh_token,
        },
      });
    } catch (error: any) {
      logger.error(`OAuth token request failed: ${error.message}`);
      
      if (error.response) {
        logger.error(`OAuth error response: ${JSON.stringify(error.response.data)}`);
        res.status(error.response.status).json({
          success: false,
          message: error.response.data.error_description || error.message,
          error: error.response.data.error,
        });
      } else {
        res.status(500).json({
          success: false,
          message: error.message,
        });
      }
    }
  }

  /**
   * Refresh an access token
   * POST /oauth/refresh
   * Body: { tenantId, clientId, clientSecret, refreshToken, siteUrl }
   */
  public async refreshToken(req: Request, res: Response): Promise<void> {
    try {
      const { tenantId, clientId, clientSecret, refreshToken, siteUrl } = req.body;

      if (!clientId || !clientSecret || !refreshToken || !siteUrl) {
        res.status(400).json({ 
          success: false, 
          message: 'Missing required fields: clientId, clientSecret, refreshToken, siteUrl' 
        });
        return;
      }

      const url = new URL(siteUrl);
      const resource = `https://${url.hostname}`;
      const tenant = tenantId || 'common';

      const tokenEndpoint = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

      const params = new URLSearchParams({
        client_id: clientId,
        scope: `${resource}/.default`,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        client_secret: clientSecret,
      });

      logger.info(`Refreshing OAuth token for SharePoint: ${resource}`);

      const response = await axios.post(tokenEndpoint, params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      res.status(200).json({
        success: true,
        token: {
          accessToken: response.data.access_token,
          expiresIn: response.data.expires_in,
          tokenType: response.data.token_type,
          refreshToken: response.data.refresh_token,
        },
      });
    } catch (error: any) {
      logger.error(`OAuth token refresh failed: ${error.message}`);
      
      if (error.response) {
        res.status(error.response.status).json({
          success: false,
          message: error.response.data.error_description || error.message,
          error: error.response.data.error,
        });
      } else {
        res.status(500).json({
          success: false,
          message: error.message,
        });
      }
    }
  }

  /**
   * Generate OAuth authorization URL with PKCE
   * GET /oauth/authorize
   * Query: { siteUrl, redirectUri? }
   */
  public async getAuthorizationUrl(req: Request, res: Response): Promise<void> {
    try {
      const { siteUrl, redirectUri } = req.query;

      if (!siteUrl) {
        res.status(400).json({ success: false, message: 'siteUrl is required' });
        return;
      }

      const clientId = process.env.AZURE_CLIENT_ID;
      const tenantId = process.env.AZURE_TENANT_ID || 'common';

      if (!clientId) {
        res.status(500).json({ 
          success: false, 
          message: 'AZURE_CLIENT_ID not configured in environment variables' 
        });
        return;
      }

      // Generate PKCE code verifier and challenge
      const codeVerifier = this.generateCodeVerifier();
      const codeChallenge = this.generateCodeChallenge(codeVerifier);
      const state = crypto.randomBytes(16).toString('hex');

      // Store verifier for later use in callback
      this.pkceStore.set(state, {
        verifier: codeVerifier,
        state: state,
        timestamp: Date.now(),
      });

      // Extract resource from site URL
      const url = new URL(siteUrl as string);
      const resource = `https://${url.hostname}`;

      // Build authorization URL
      const finalRedirectUri = redirectUri || `${process.env.FRONTEND_URL || 'http://localhost:4080'}/oauth-callback.html`;
      
      const authUrl = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
      authUrl.searchParams.append('client_id', clientId);
      authUrl.searchParams.append('response_type', 'code');
      authUrl.searchParams.append('redirect_uri', finalRedirectUri as string);
      authUrl.searchParams.append('response_mode', 'query');
      authUrl.searchParams.append('scope', `${resource}/.default offline_access`);
      authUrl.searchParams.append('state', state);
      authUrl.searchParams.append('code_challenge', codeChallenge);
      authUrl.searchParams.append('code_challenge_method', 'S256');

      logger.info(`Generated OAuth authorization URL for SharePoint: ${resource}`);

      res.status(200).json({
        success: true,
        authorizationUrl: authUrl.toString(),
        state: state,
      });
    } catch (error: any) {
      logger.error(`Failed to generate authorization URL: ${error.message}`);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }

  /**
   * Handle OAuth callback and exchange code for token
   * POST /oauth/callback
   * Body: { code, state, siteUrl, redirectUri? }
   */
  public async handleCallback(req: Request, res: Response): Promise<void> {
    try {
      const { code, state, siteUrl, redirectUri } = req.body;

      if (!code || !state || !siteUrl) {
        res.status(400).json({ 
          success: false, 
          message: 'code, state, and siteUrl are required' 
        });
        return;
      }

      const clientId = process.env.AZURE_CLIENT_ID;
      const clientSecret = process.env.AZURE_CLIENT_SECRET;
      const tenantId = process.env.AZURE_TENANT_ID || 'common';

      if (!clientId || !clientSecret) {
        res.status(500).json({ 
          success: false, 
          message: 'AZURE_CLIENT_ID and AZURE_CLIENT_SECRET not configured' 
        });
        return;
      }

      // Retrieve PKCE verifier
      const pkceData = this.pkceStore.get(state);
      if (!pkceData) {
        res.status(400).json({ 
          success: false, 
          message: 'Invalid or expired state parameter' 
        });
        return;
      }

      // Clean up used verifier
      this.pkceStore.delete(state);

      // Extract resource from site URL
      const url = new URL(siteUrl);
      const resource = `https://${url.hostname}`;
      const finalRedirectUri = redirectUri || `${process.env.FRONTEND_URL || 'http://localhost:4080'}/oauth-callback.html`;

      // Exchange code for token
      const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,  // Required for "Web" platform
        scope: `${resource}/.default offline_access`,
        code: code,
        redirect_uri: finalRedirectUri,
        grant_type: 'authorization_code',
        code_verifier: pkceData.verifier,
      });

      logger.info(`Exchanging authorization code for token: ${resource}`);

      const response = await axios.post(tokenEndpoint, params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      res.status(200).json({
        success: true,
        token: {
          accessToken: response.data.access_token,
          expiresIn: response.data.expires_in,
          tokenType: response.data.token_type,
          refreshToken: response.data.refresh_token,
        },
      });
    } catch (error: any) {
      logger.error(`OAuth callback failed: ${error.message}`);
      
      if (error.response) {
        logger.error(`OAuth error response: ${JSON.stringify(error.response.data)}`);
        res.status(error.response.status).json({
          success: false,
          message: error.response.data.error_description || error.message,
          error: error.response.data.error,
        });
      } else {
        res.status(500).json({
          success: false,
          message: error.message,
        });
      }
    }
  }

  /**
   * Generate PKCE code verifier (random string)
   */
  private generateCodeVerifier(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  /**
   * Generate PKCE code challenge from verifier
   */
  private generateCodeChallenge(verifier: string): string {
    return crypto
      .createHash('sha256')
      .update(verifier)
      .digest('base64url');
  }
}
