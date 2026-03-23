import type { ShopifyGraphQLClient } from './client.js';

const registerMutation = `
mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    userErrors { field message }
    webhookSubscription { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } }
  }
}`;

export const registerShopWebhooks = async (
  client: ShopifyGraphQLClient,
  callbackBaseUrl: string,
): Promise<void> => {
  const topics = [
    'PRODUCTS_CREATE',
    'PRODUCTS_UPDATE',
    'PRODUCTS_DELETE',
    'COLLECTIONS_CREATE',
    'COLLECTIONS_UPDATE',
    'COLLECTIONS_DELETE',
    'APP_UNINSTALLED',
  ];
  for (const topic of topics) {
    await client.execute(registerMutation, {
      topic,
      webhookSubscription: {
        callbackUrl: `${callbackBaseUrl}/webhooks/shopify`,
        format: 'JSON',
      },
    });
  }
};
