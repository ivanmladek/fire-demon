import os
import requests
import re
import time
import json

FIRECRAWL_KEY = os.environ.get("FIRECRAWL_KEY")
CLAUDE_KEY = os.environ.get("CLAUDE_KEY")
FIRECRAWL_URL = "https://api.firecrawl.dev/v1"


def scrape_site(url):
    resp = requests.post(
        f"{FIRECRAWL_URL}/scrape",
        headers={"Authorization": f"Bearer {FIRECRAWL_KEY}"},
        json={
            "url": url,
            "formats": ["markdown"],
            "onlyMainContent": True,
            "blockAds": True,
            "removeBase64Images": True,
            "timeout": 15000,
        }
    )
    resp.raise_for_status()
    return resp.json()


def ask_llm_for_crawl_command(url, scrape_summary):
    prompt = f"""
You are a web crawling expert. Given the following website and a summary of its main page, suggest the optimal Firecrawl /crawl endpoint command (as a curl command) for maximum coverage and efficiency.
- If the site is media-heavy or has anti-bot tech, recommend stealth proxies and playwright engine.
- If it's mostly text and simple, use basic proxy and fetch engine.
- Set reasonable limits and maxDepth.
- Exclude obvious non-content paths.
- Output ONLY the explanation and the curl command, nothing else.

Here is the full Python example for the Firecrawl /crawl endpoint:

```python
import requests

url = "https://api.firecrawl.dev/v1/crawl"

payload = {{
    "url": "<string>",
    "excludePaths": ["<string>"],
    "includePaths": ["<string>"],
    "maxDepth": 10,
    "maxDiscoveryDepth": 123,
    "ignoreSitemap": False,
    "ignoreQueryParameters": False,
    "limit": 10000,
    "allowBackwardLinks": False,
    "allowExternalLinks": False,
    "delay": 123,
    "webhook": {{
        "url": "<string>",
        "headers": {{}},
        "metadata": {{}},
        "events": ["completed"]
    }},
    "scrapeOptions": {{
        "formats": ["markdown"],
        "onlyMainContent": True,
        "includeTags": ["<string>"],
        "excludeTags": ["<string>"],
        "maxAge": 0,
        "headers": {{}},
        "waitFor": 0,
        "mobile": False,
        "skipTlsVerification": False,
        "timeout": 30000,
        "parsePDF": True,
        "jsonOptions": {{
            "schema": {{}},
            "systemPrompt": "<string>",
            "prompt": "<string>"
        }},
        "actions": [
            {{
                "type": "wait",
                "milliseconds": 2,
                "selector": "#my-element"
            }}
        ],
        "location": {{
            "country": "US",
            "languages": ["en-US"]
        }},
        "removeBase64Images": True,
        "blockAds": True,
        "proxy": "basic",
        "changeTrackingOptions": {{
            "modes": ["git-diff"],
            "schema": {{}},
            "prompt": "<string>",
            "tag": None
        }},
        "storeInCache": True
    }}
}}
headers = {{
    "Authorization": "Bearer <token>",
    "Content-Type": "application/json"
}}

response = requests.request("POST", url, json=payload, headers=headers)

print(response.text)
```

Here is an example of a complex prompt for an extremely large, but simple, site:

```
#!/bin/bash

# Crawl ContactOut profile pages
curl -X POST https://api.firecrawl.dev/v1/crawl \
-H \"Authorization: Bearer test-api-key-123\" \
-H \"Content-Type: application/json\" \
-d '{{
  "url": "https://contactout.com/Deborah-Sleep-23965757",
  "allowBackwardLinks": true,
  "limit": 250000000,
  "maxDepth": 10000,
  "allowExternalLinks": false,
  "ignoreSitemap": true,

  "excludePaths": [
    "^https://contactout\\.com/?$",
    "/alternative",
    "/api-feature",
    "/blog",
    "/celebrity-directory",
    "/chrome-extension",
    "/clients",
    "/company-directory",
    "/company/.*-email-format-",
    "/contact",
    "/cdn-cgi/",
    "/data-enrichment-feature",
    "/email-campaigns",
    "/email-lists",
    "/email_verifier",
    "/famous-people-directory",
    "/free-tools",
    "/gmail-enrichment-feature",
    "/integrations-feature",
    "/login",
    "/meeting",
    "/our-data",
    "/optout",
    "/password/reset",
    "/pricing",
    "/privacy",
    "/privacy_policy",
    "/recruiters",
    "/register",
    "/sales-prospecting",
    "/sales-users",
    "/search-portal",
    "/terms"
  ],
  "scrapeOptions": {{
    "removeBase64Images": true,
    "blockAds": true,
    "proxy": "basic",
    "formats": ["markdown"],
    "onlyMainContent": true,
    "excludeTags": [
      "img",
      "script",
      "style",
      "noscript",
      "iframe",
      "embed",
      "object",
      "video",
      "audio",
      "canvas",
      "svg",
      "picture",
      "source",
      "track",
      "map",
      "area",
      "link",
      "meta",
      "head",
      "footer",
      "nav",
      "aside",
      "header"
    ]
  }}
}}'
```

---

Website: {url}

Scrape summary:
{scrape_summary}

---

First, explain your reasoning for the recommended crawl command (in a short paragraph or bullet points). Then, on a new line, output the ready-to-run curl command. Clearly separate the explanation and the command with a heading or divider (e.g., '---').
"""
    # Try Anthropic first
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=os.environ.get("CLAUDE_KEY"))
        msg = client.messages.create(
            model="claude-3-7-sonnet-20250219",
            max_tokens=700,
            temperature=0.2,
            system="You are a helpful assistant.",
            messages=[{"role": "user", "content": prompt}]
        )
        return msg.content[0].text.strip()
    except Exception as e:
        print(f"[Warning] Anthropic failed ({e}), falling back to OpenAI GPT-4.")
        import openai
        openai.api_key = os.environ.get("OPENAI_API_KEY")
        response = openai.ChatCompletion.create(
            model="gpt-4.1-2025-04-14",
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": prompt}
            ],
            max_tokens=700,
            temperature=0.2,
        )
        return response['choices'][0]['message']['content'].strip()


def ask_llm_to_fix_payload(payload, error):
    import anthropic
    client = anthropic.Anthropic(api_key=CLAUDE_KEY)
    prompt = f"""
The following Firecrawl /crawl request payload failed with the error below. Please correct the JSON payload and output ONLY the corrected JSON (no explanation, no commentary, just the JSON). If you need to change fields, do so. If you need to add or remove keys, do so. Make sure the JSON is ready to POST to the /crawl endpoint.

Original payload:
```
{json.dumps(payload, indent=2)}
```

Error message:
```
{error}
```
"""
    msg = client.messages.create(
        model="claude-opus-4-20250514",
        max_tokens=700,
        temperature=0.2,
        system="You are a helpful assistant.",
        messages=[{"role": "user", "content": prompt}]
    )
    return msg.content[0].text.strip()


def extract_json_payload(llm_output):
    # Try to find a JSON block in the LLM output
    # 1. Look for triple-backtick code block with JSON
    json_block = None
    code_blocks = re.findall(r'```(?:json)?\n([\s\S]+?)```', llm_output)
    for block in code_blocks:
        try:
            # Try to parse as JSON
            return json.loads(block)
        except Exception:
            continue
    # 2. Look for -d '...'
    d_match = re.search(r"-d\s+'({[\s\S]+?})'", llm_output)
    if d_match:
        try:
            # Replace single quotes with double quotes for JSON
            json_str = d_match.group(1).replace("'", '"')
            return json.loads(json_str)
        except Exception:
            pass
    # 3. Look for first { ... } block
    brace_match = re.search(r'({[\s\S]+})', llm_output)
    if brace_match:
        try:
            return json.loads(brace_match.group(1))
        except Exception:
            pass
    return None


def execute_crawl_request(payload):
    url = f"{FIRECRAWL_URL}/crawl"
    headers = {
        "Authorization": f"Bearer {FIRECRAWL_KEY}",
        "Content-Type": "application/json"
    }
    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=120)
        return resp.status_code, resp.text
    except Exception as e:
        return 500, str(e)


def extract_crawl_id(response_text):
    try:
        data = json.loads(response_text)
        for key in ['id', 'crawlId', 'crawl_id']:
            if key in data:
                return data[key]
        if 'data' in data and isinstance(data['data'], dict):
            for key in ['id', 'crawlId', 'crawl_id']:
                if key in data['data']:
                    return data['data'][key]
    except Exception:
        pass
    return None


def monitor_crawl_job(crawl_id):
    print(f"Monitoring crawl job with ID: {crawl_id}")
    status_url = f"{FIRECRAWL_URL}/crawl/{crawl_id}"
    headers = {"Authorization": f"Bearer {FIRECRAWL_KEY}"}
    for _ in range(60):  # Poll for up to 10 minutes
        try:
            resp = requests.get(status_url, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                print(f"Status: {data.get('status', 'unknown')}")
                if data.get('status') in ['completed', 'failed', 'cancelled']:
                    print("Final crawl job data:")
                    print(data)
                    summarize_crawl_results(data)
                    return
            else:
                print(f"Status check failed: {resp.status_code} {resp.text}")
        except Exception as e:
            print(f"Error checking crawl status: {e}")
        time.sleep(10)
    print("Crawl job monitoring timed out.")


def summarize_crawl_results(crawl_job):
    data = crawl_job.get('data', [])
    num_pages = len(data)
    num_with_images = sum(1 for page in data if 'markdown' in page and '![](' in page['markdown'])
    num_with_text = sum(1 for page in data if 'markdown' in page and len(page['markdown'].strip()) > 100)
    # Heuristic: if completed == total and most pages have text, high score
    completed = crawl_job.get('completed', 0)
    total = crawl_job.get('total', 0)
    success_ratio = completed / total if total else 0
    richness = (num_with_text + num_with_images) / num_pages if num_pages else 0
    # Score: 10 if >90% success and richness, 5 if ~50%, else lower
    score = int(round(10 * min(success_ratio, richness)))
    print(f"\nCrawl Summary:")
    print(f"- Pages crawled: {num_pages}")
    print(f"- Pages with images: {num_with_images}")
    print(f"- Pages with substantial text: {num_with_text}")
    print(f"- Success ratio: {success_ratio:.2f}")
    print(f"- Content richness: {richness:.2f}")
    print(f"- Prompt effectiveness (1-10): {score}/10")
    return score


def main():
    url = input("Enter the website URL to crawl: ").strip()
    print("Scraping the site for analysis...")
    scrape_result = scrape_site(url)
    summary = scrape_result.get("data", {}).get("content", "")[:2000]  # Truncate for LLM
    print("Consulting LLM for optimal crawl command and reasoning...")

    # Data broker check using firecrawl public endpoint
    try:
        from firecrawl import JsonConfig, FirecrawlApp
        from pydantic import BaseModel
        class ExtractSchema(BaseModel):
            is_data_broker: bool

        app = FirecrawlApp(api_key=FIRECRAWL_KEY)
        json_config = JsonConfig(schema=ExtractSchema)
        broker_result = app.scrape_url(
            url,
            formats=["json"],
            json_options=json_config,
            only_main_content=False,
            timeout=120000
        )
        is_broker = False
        try:
            is_broker = broker_result.json.get('is_data_broker', False)
        except Exception:
            pass

    except Exception as e:
        print(f"[Warning] Could not check data broker status: {e}")

    llm_output = ask_llm_for_crawl_command(url, summary)
    print("\nLLM Explanation and Recommended Firecrawl /crawl command:\n")
    print(llm_output)

    # Extract and execute the crawl payload
    payload = extract_json_payload(llm_output)
    if not payload:
        print("Could not extract a JSON payload from the LLM output.")
        return

    if is_broker:
        print("\nThis website appears to be a data broker (contains millions of people profiles). Please contact Firecrawl for specialized support. Exiting.")
        return

    max_retries = 3
    for attempt in range(1, max_retries+1):
        print(f"\nAttempt {attempt}: Executing crawl request...")
        status_code, response_text = execute_crawl_request(payload)
        if status_code == 200 and response_text:
            print("Crawl request executed successfully. Response:")
            print(response_text)
            crawl_id = extract_crawl_id(response_text)
            if crawl_id:
                monitor_crawl_job(crawl_id)
            else:
                print("Could not extract crawl ID from response.")
            break
        else:
            print(f"Crawl request failed. Error:\n{response_text}")
            if attempt < max_retries:
                print("Asking LLM to correct the payload and retrying...")
                fixed_json = ask_llm_to_fix_payload(payload, response_text)
                try:
                    payload = json.loads(fixed_json)
                except Exception:
                    print("LLM returned invalid JSON. Exiting.")
                    break
            else:
                print("Max retries reached. Exiting.")


if __name__ == "__main__":
    main() 