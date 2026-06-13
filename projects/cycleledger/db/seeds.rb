# Seeds — synthetic, clearly-fictional campaign-contribution data.
#
# Tens of thousands of contributions across cycles (2022/2024/2026) and a dozen
# committees, with a deterministic RNG so the rollup numbers, EXPLAIN plan, and
# tests are reproducible to the digit. NO real PII: donor names are obviously
# fictional ("Donor 04217"), committee names are invented.
#
# Idempotent: clears the three tables first, so re-seeding never double-counts.

require "securerandom"

RNG = Random.new(424242) # fixed seed -> reproducible dataset

DONOR_COUNT = Integer(ENV.fetch("SEED_DONORS", 4_000))
CONTRIBS_PER_CYCLE = Integer(ENV.fetch("SEED_CONTRIBS_PER_CYCLE", 12_000))
CYCLES = Contribution::PARTITIONED_CYCLES

STATES = %w[CA NY TX FL PA OH IL GA NC MI WA AZ MA VA CO].freeze
CITIES = %w[Springfield Riverton Fairview Madison Georgetown Clinton Franklin
            Greenville Bristol Salem Ashland Oakdale].freeze
OCCUPATIONS = ["Software Engineer", "Teacher", "Attorney", "Physician", "Retired",
               "Small Business Owner", "Consultant", "Nurse", "Professor",
               "Accountant", "Not Employed", "Homemaker"].freeze
EMPLOYERS = ["Acme Corp", "Globex", "Initech", "Self-Employed", "Hooli",
             "Stark Industries", "Wayne Enterprises", "Umbrella Co", "N/A",
             "Vandelay Industries"].freeze

COMMITTEES = [
  { fec_id: "C9000001", name: "Citizens for a Brighter Tomorrow", committee_type: "presidential", party: "DEM" },
  { fec_id: "C9000002", name: "Forward Together Committee",        committee_type: "presidential", party: "REP" },
  { fec_id: "C9000003", name: "Heartland Values PAC",              committee_type: "pac",          party: "REP" },
  { fec_id: "C9000004", name: "Coastal Progress Fund",             committee_type: "pac",          party: "DEM" },
  { fec_id: "C9000005", name: "Friends of Jordan Rivera (Senate)", committee_type: "senate",       party: "DEM" },
  { fec_id: "C9000006", name: "Casey Morgan for Senate",           committee_type: "senate",       party: "REP" },
  { fec_id: "C9000007", name: "Taylor Quinn for Congress",         committee_type: "house",        party: "DEM" },
  { fec_id: "C9000008", name: "Avery Brooks House Committee",      committee_type: "house",        party: "REP" },
  { fec_id: "C9000009", name: "Independent Voices Alliance",       committee_type: "pac",          party: "IND" },
  { fec_id: "C9000010", name: "Main Street Prosperity PAC",        committee_type: "pac",          party: nil   },
].freeze

puts "[seed] clearing contributions / donors / committees ..."
# Order matters: contributions FK donors & committees.
ActiveRecord::Base.connection.execute("TRUNCATE contributions RESTART IDENTITY")
Donor.delete_all
Committee.delete_all

puts "[seed] committees ..."
committees = COMMITTEES.map { |attrs| Committee.create!(attrs) }
committee_ids = committees.map(&:id)

puts "[seed] #{DONOR_COUNT} donors ..."
donor_rows = Array.new(DONOR_COUNT) do |i|
  state = STATES[RNG.rand(STATES.length)]
  {
    full_name: format("Donor %05d", i + 1),
    city: CITIES[RNG.rand(CITIES.length)],
    state: state,
    zip: format("%05d", RNG.rand(100_000)),
    employer: EMPLOYERS[RNG.rand(EMPLOYERS.length)],
    occupation: OCCUPATIONS[RNG.rand(OCCUPATIONS.length)],
    created_at: Time.current,
    updated_at: Time.current,
  }
end
# Bulk-insert via raw multi-row VALUES. We avoid Active Record's insert_all!
# here because the contributions model declares a logical primary_key while the
# physical table has a composite PK — insert_all!'s unique-index lookup does not
# model that. Raw INSERT is also the honest pattern for high-volume bulk loads.
conn = ActiveRecord::Base.connection
def q(conn, v)
  v.nil? ? "NULL" : conn.quote(v)
end

donor_values = donor_rows.map do |d|
  "(#{q(conn, d[:full_name])}, #{q(conn, d[:city])}, #{q(conn, d[:state])}, " \
    "#{q(conn, d[:zip])}, #{q(conn, d[:employer])}, #{q(conn, d[:occupation])}, now(), now())"
end
donor_values.each_slice(1_000) do |slice|
  conn.execute(
    "INSERT INTO donors (full_name, city, state, zip, employer, occupation, " \
    "created_at, updated_at) VALUES #{slice.join(',')}",
  )
end
donor_ids = Donor.order(:id).pluck(:id)

# Skewed amount: most contributions are small (below $200), a long tail is large
# — so the $200 itemized/unitemized split is meaningful, like real FEC data.
def draw_amount(rng)
  r = rng.rand
  if r < 0.70
    (5 + rng.rand * 190).round(2)        # small: $5–$195 (mostly unitemized)
  elsif r < 0.95
    (200 + rng.rand * 1_300).round(2)    # mid: $200–$1500
  else
    (1_500 + rng.rand * 1_900).round(2)  # large: up to ~$3400
  end
end

CYCLES.each do |cycle|
  puts "[seed] cycle #{cycle}: #{CONTRIBS_PER_CYCLE} contributions ..."
  start = Date.new(cycle - 1, 1, 1)
  span_days = 700
  values = Array.new(CONTRIBS_PER_CYCLE) do
    donor_id    = donor_ids[RNG.rand(donor_ids.length)]
    committee_id = committee_ids[RNG.rand(committee_ids.length)]
    amount      = draw_amount(RNG)
    on          = start + RNG.rand(span_days)
    employer    = EMPLOYERS[RNG.rand(EMPLOYERS.length)]
    occupation  = OCCUPATIONS[RNG.rand(OCCUPATIONS.length)]
    "(#{donor_id}, #{committee_id}, #{cycle}, #{amount}, #{q(conn, on)}, " \
      "#{q(conn, employer)}, #{q(conn, occupation)}, now(), now())"
  end
  # Each row's `cycle` value routes it to its partition automatically.
  values.each_slice(2_000) do |slice|
    conn.execute(
      "INSERT INTO contributions (donor_id, committee_id, cycle, amount, " \
      "occurred_on, employer, occupation, created_at, updated_at) " \
      "VALUES #{slice.join(',')}",
    )
  end
end

total = Contribution.count
puts "[seed] done: #{Committee.count} committees, #{Donor.count} donors, #{total} contributions."
CYCLES.each do |c|
  puts "[seed]   cycle #{c}: #{Contribution.where(cycle: c).count} rows"
end
